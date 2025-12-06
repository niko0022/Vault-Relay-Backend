const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../db/prismaClient');

const ACCESS_EXPIRES = Number(process.env.ACCESS_TOKEN_EXPIRES) || 300; // seconds
const REFRESH_EXPIRES = Number(process.env.REFRESH_TOKEN_EXPIRES) || 60 * 60 * 24 * 7; // seconds (7 days)
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
if (!ACCESS_SECRET) throw new Error('Missing JWT_ACCESS_SECRET env variable');

// small helper for TokenError
function TokenError(message) {
  const err = new Error(message);
  err.name = 'TokenError';
  return err;
}

function signAccessToken(user) {
  const sub = user?.id ?? user;
  if (!sub) throw new Error('signAccessToken requires user id or user object with id');
  const payload = {sub}
  const token = jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES });
  return token;
}

function randomRefreshTokenPlain(len = 48) {
  return crypto.randomBytes(len).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken({ userId, userAgent = null, deviceId = null} = {}) {
  if (!userId) throw new Error('issueRefreshToken requires userId');
  const plain = randomRefreshTokenPlain(64);
  const tokenHash = hashToken(plain);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_EXPIRES * 1000);

  const created = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent,
      deviceId, 
    },
  });

  return {created, plain};
}

async function findTokenByHash(plainToken) {
  if (!plainToken) return null;
  const hashed = hashToken(plainToken);
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: {
      tokenHash: hashed,
    }
  });
  return tokenRecord;
}


async function rotateRefreshToken({ currentToken, userAgent = null, deviceId = null} = {}) {
  if (!currentToken) throw TokenError('No token provided');

  const tokenRecord = await findTokenByHash(currentToken);

  if (!tokenRecord) {
    // token not found: could be invalid or already used/revoked
    throw TokenError('Refresh token not found or already used');
  }

  if (tokenRecord.revoked) {
    // suspicious reuse: revoke all tokens for user defensively
    await prisma.refreshToken.updateMany({
      where: { userId: tokenRecord.userId },
      data: { revoked: true },
    });
    throw TokenError('Refresh token revoked');
  }

  if (tokenRecord.expiresAt < new Date()) {
    throw TokenError('Refresh token expired');
  }

  // Create new token record first
  const newRefreshPlain = randomRefreshTokenPlain(64);
  const newHash = hashToken(newRefreshPlain);
  const newExpiresAt = new Date(Date.now() + REFRESH_EXPIRES * 1000);

  // Use transaction to create token and then atomically update old token (updateMany ensures conditional update)
  // NOTE: updateMany returns { count } (Prisma returns number of records updated)
  const created = await prisma.refreshToken.create({
    data: {
      userId: tokenRecord.userId,
      tokenHash: newHash,
      expiresAt: newExpiresAt,
      userAgent,
      deviceId,
    },
  });

  // Try to mark the old token revoked only if it's still not revoked.
  const updateResult = await prisma.refreshToken.updateMany({
    where: { id: tokenRecord.id, revoked: false },
    data: { revoked: true, replacedById: created.id, lastUsedAt: new Date() },
  });

  if (updateResult.count === 0) {
    // someone else used/revoked the token concurrently — treat as reuse/compromise
    // cleanup: remove created token (best-effort)
    try {
      await prisma.refreshToken.delete({ where: { id: created.id } });
    } catch (e) {
      // ignore cleanup errors but log in real app
      console.error('Cleanup failed for created token after concurrent reuse', e);
    }
    // defensive: revoke all tokens for the user
    await prisma.refreshToken.updateMany({
      where: { userId: tokenRecord.userId },
      data: { revoked: true },
    });
    throw TokenError('Refresh token reuse detected');
  }

  // issue access token
  const accessToken = signAccessToken(tokenRecord.userId);

  return { accessToken, refreshToken: newRefreshPlain  };
}

async function revokeRefreshToken({ currentToken }) {
  if (!currentToken) return null;
  const tokenRecord = await findTokenByHash(currentToken);
  if (!tokenRecord) return null;
  return prisma.refreshToken.update({ where: { id: tokenRecord.id }, data: { revoked: true, lastUsedAt: new Date() } });
}


async function pruneExpiredTokens({ revokeOnlyOlderThanDays = 30 } = {}) {
  const now = new Date();

  // 1) delete tokens that are expired and were revoked (cleanup)
  await prisma.refreshToken.deleteMany({
    where: {
      expiresAt: { lt: now },
      revoked: true,
    },
  });

  // 2) optionally delete tokens that were revoked more than revokeOnlyOlderThanDays ago
  if (revokeOnlyOlderThanDays > 0) {
    const cutoff = new Date(Date.now() - revokeOnlyOlderThanDays * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.deleteMany({
      where: {
        revoked: true,
        createdAt: { lt: cutoff },
      },
    });
  }

  // 3) delete tokens that are expired (regardless of revoked) - optional
  await prisma.refreshToken.deleteMany({
    where: {
      expiresAt: { lt: now },
    },
  });

  return true;
}

module.exports = {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  pruneExpiredTokens,
};
