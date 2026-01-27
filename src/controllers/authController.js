const passportModule = require('passport');
const { validationResult } = require('express-validator');
const tokenService = require('../services/tokenService');
const argon2 = require('argon2');
const prisma = require('../db/prismaClient');
const generateByUsername  = require('../utils/generateFriendCode');
const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_EXPIRES_SEC = Number(process.env.REFRESH_TOKEN_EXPIRES || 60 * 60 * 24 * 7);

// Helper: wrap passport authenticate to use custom callback (so we can return tokens)
function authenticateLocal(req, res) {
  return new Promise((resolve, reject) => {
    passportModule.authenticate('local', { session: false }, (err, user, info) => {
      if (err) return reject(err);
      if (!user) return resolve({ error: 'Invalid credentials', info });
      return resolve({ user });
    })(req, res);
  });
}

exports.register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const email = String(req.body.email).toLowerCase();
    const password = String(req.body.password);
    const displayName = req.body.displayName ? String(req.body.displayName).trim() : null;
    const username = req.body.username ? String(req.body.username).trim() : null;

    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    if (existingByEmail) {
      return res.status(409).json({ message: 'Account with this email already exists' });
    }
    if (username) {
      const existingByUsername = await prisma.user.findUnique({ where: { username } });
      if (existingByUsername) {
        return res.status(409).json({ message: 'Username already taken' });
      }
    }

    const passwordHash = await argon2.hash(password);
    const preferredBase = username;
    const friendCode = generateByUsername(preferredBase);
    let created;

    try {
      created = await prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName,
          username,
          friendCode,
        },
      });
    } catch (err) {
      // handle unique constraint errors intelligently
      if (err && (err.code === 'P2002' || err.code === '23505')) {
        // If DB tells us which column, respond accordingly
        const targets = err.meta && Array.isArray(err.meta.target) ? err.meta.target : [];

        if (targets.includes('email') || targets.includes('username')) {
          return res.status(409).json({ message: 'Email or username already exists' });
        }

        if (targets.includes('friendCode') || (err.code === '23505' && String(err.message).includes('friend_code'))) {
          // Generated friendCode collided — we didn't retry by design.
          return res.status(500).json({ message: 'Could not generate unique friend code, please try again' });
        }

        // Fallback for other unique constraint collisions
        return res.status(409).json({ message: 'Duplicate field exists' });
      }

      throw err;
    }

    const safeUser = { ...created };
    delete safeUser.passwordHash;

    const accessToken = tokenService.signAccessToken(created.id);

    const rtResult = await tokenService.issueRefreshToken({ userId: created.id, userAgent: req.get('user-agent') });
    const refreshPlain = rtResult?.token ?? rtResult?.plain ?? (typeof rtResult === 'string' ? rtResult : null);

    if (refreshPlain) {
      res.cookie(REFRESH_COOKIE_NAME, refreshPlain, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === 'true',
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_EXPIRES_SEC * 1000,
      });
    } else {
      console.warn('issueRefreshToken did not return plaintext token', rtResult);
    }

    return res.status(201).json({ accessToken, user: safeUser });
  } catch (err) {
    // final catch: map DB unique errors (if we missed above)
    if (err?.code === 'P2002' || err?.code === '23505') {
      return res.status(409).json({ message: 'Email or username already exists' });
    }
    return next(err);
  }
};


exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = await authenticateLocal(req, res);
    if (result.error) return res.status(401).json({ message: 'Invalid credentials' });

    const user = result.user;
    const accessToken = tokenService.signAccessToken(user.id);
    const rtResult = await tokenService.issueRefreshToken({ userId: user.id, userAgent: req.get('user-agent') });

    // normalize plaintext from varied return shapes: { token }, { plain }, just-string, etc.
    const refreshPlain = rtResult?.token ?? rtResult?.plain ?? (typeof rtResult === 'string' ? rtResult : null);

    if (refreshPlain) {
      res.cookie(REFRESH_COOKIE_NAME, refreshPlain, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === 'true',
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_EXPIRES_SEC * 1000,
      });
    } else {
      // if service unexpectedly didn't return plaintext, warn (you may want to treat as error)
      console.warn('issueRefreshToken did not return plaintext token', rtResult);
    }
    return res.json({ accessToken });
  } catch (err) {
    return next(err);
  }
};


exports.refresh = async (req, res, next) => {
  try {
    const currentToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
    if (!currentToken) return res.status(401).json({ message: 'No refresh token' });

    // rotateRefreshToken returns { accessToken, refreshToken }
    const { accessToken, refreshToken: newRefreshPlain } = await tokenService.rotateRefreshToken({ currentToken });

    // set new refresh token cookie (controller is responsible for cookie now)
    res.cookie(REFRESH_COOKIE_NAME, newRefreshPlain, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_EXPIRES_SEC * 1000,
    });

    return res.json({ accessToken });
  } catch (err) {
    if (err && err.name === 'TokenError') {
      // defensive: clear cookie so client doesn't keep sending bad token
      res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
      return res.status(401).json({ message: err.message });
    }
    return next(err);
  }
};

exports.logout = async (req, res, next) => {
  try {
    const currentToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
    if (currentToken) {
      // revoke token in DB (best-effort)
      await tokenService.revokeRefreshToken({ currentToken });
    }

    // clear cookie on client
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      path: '/',
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};
