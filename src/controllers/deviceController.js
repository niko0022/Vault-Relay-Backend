const { validationResult } = require('express-validator');
const prisma = require('../db/prismaClient');
const tokenService = require('../services/tokenService');

const REFRESH_COOKIE_NAME = 'refreshToken';
const ACCESS_COOKIE_NAME = 'accessToken';
const ACCESS_EXPIRES_SEC = Number(process.env.ACCESS_TOKEN_EXPIRES || 300);
const REFRESH_EXPIRES_SEC = Number(process.env.REFRESH_TOKEN_EXPIRES || 60 * 60 * 24 * 7);

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  path: '/',
};

exports.registerDevice = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const deviceName = req.body.deviceName || 'Web Client';

    const count = await prisma.device.count({ where: { userId } });
    if (count >= 5) {
      return res.status(400).json({ message: 'Device limit reached (maximum 5 devices)' });
    }

    // Determine deviceId (sequential number from 1 to 5 per user)
    const devices = await prisma.device.findMany({
      where: { userId },
      select: { deviceId: true },
    });
    const existingIds = new Set(devices.map(d => d.deviceId));
    let nextId = 1;
    for (let i = 1; i <= 5; i++) {
      if (!existingIds.has(i)) {
        nextId = i;
        break;
      }
    }

    const isPrimary = nextId === 1;

    // Create the device
    const device = await prisma.device.create({
      data: {
        userId,
        deviceId: nextId,
        deviceName,
        isPrimary,
      },
    });

    // Re-issue tokens with deviceId embedded
    const accessToken = tokenService.signAccessToken(userId, nextId);
    const rtResult = await tokenService.issueRefreshToken({
      userId,
      userAgent: req.get('user-agent'),
      deviceId: String(nextId),
    });
    const { plain: refreshPlain } = rtResult;

    res.cookie(ACCESS_COOKIE_NAME, accessToken, { ...COOKIE_OPTS, maxAge: ACCESS_EXPIRES_SEC * 1000 });
    if (refreshPlain) {
      res.cookie(REFRESH_COOKIE_NAME, refreshPlain, { ...COOKIE_OPTS, maxAge: REFRESH_EXPIRES_SEC * 1000 });
    }

    return res.status(201).json({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      isPrimary: device.isPrimary,
    });
  } catch (err) {
    next(err);
  }
};

exports.listDevices = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const devices = await prisma.device.findMany({
      where: { userId },
      orderBy: { deviceId: 'asc' },
      select: {
        deviceId: true,
        deviceName: true,
        isPrimary: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });
    return res.json(devices);
  } catch (err) {
    next(err);
  }
};

exports.unlinkDevice = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const targetId = parseInt(req.params.deviceId);
    const requesterDeviceId = req.deviceId;

    const requesterDevice = await prisma.device.findUnique({
      where: { userId_deviceId: { userId, deviceId: requesterDeviceId } },
    });

    const targetDevice = await prisma.device.findUnique({
      where: { userId_deviceId: { userId, deviceId: targetId } },
    });

    if (!targetDevice) {
      return res.status(404).json({ message: 'Device not found' });
    }

    // Permission check: only primary device can unlink others, or a device can unlink itself
    if (targetId !== requesterDeviceId && (!requesterDevice || !requesterDevice.isPrimary)) {
      return res.status(403).json({ message: 'Forbidden: only the primary device can unlink other devices' });
    }

    // Delete the device
    await prisma.device.delete({
      where: { id: targetDevice.id },
    });

    // Revoke refresh tokens for unlinked device
    await prisma.refreshToken.updateMany({
      where: { userId, deviceId: String(targetId) },
      data: { revoked: true },
    });

    // If unlinking oneself, clear session cookies
    if (targetId === requesterDeviceId) {
      res.clearCookie(ACCESS_COOKIE_NAME, COOKIE_OPTS);
      res.clearCookie(REFRESH_COOKIE_NAME, COOKIE_OPTS);
      return res.status(200).json({ message: 'Device unlinked, signed out successfully', selfUnlinked: true });
    }

    return res.json({ message: 'Device unlinked successfully', selfUnlinked: false });
  } catch (err) {
    next(err);
  }
};

exports.requestRecoveryCode = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });

    // Generate random 6-digit code
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Save code to database
    await prisma.deviceRecoveryCode.create({
      data: {
        userId,
        code,
        expiresAt,
      },
    });

    // Mock Email: print to console logs
    console.log('\n==================================================');
    console.log(`[MOCK EMAIL] Promotion recovery code for user ${user.email}: ${code}`);
    console.log('==================================================\n');

    return res.json({ message: 'Recovery code sent to your email (check console logs)' });
  } catch (err) {
    next(err);
  }
};

exports.verifyRecoveryCode = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const { code } = req.body;
    const requesterDeviceId = req.deviceId;

    if (!code) {
      return res.status(400).json({ message: 'Code is required' });
    }

    const recoveryRecord = await prisma.deviceRecoveryCode.findFirst({
      where: {
        userId,
        code: String(code).trim(),
        expiresAt: { gt: new Date() },
      },
    });

    if (!recoveryRecord) {
      return res.status(400).json({ message: 'Invalid or expired recovery code' });
    }

    // Valid code: Promote requester device to primary, demote all others
    await prisma.$transaction([
      prisma.device.updateMany({
        where: { userId },
        data: { isPrimary: false },
      }),
      prisma.device.update({
        where: { userId_deviceId: { userId, deviceId: requesterDeviceId } },
        data: { isPrimary: true },
      }),
      prisma.deviceRecoveryCode.delete({
        where: { id: recoveryRecord.id },
      }),
    ]);

    return res.json({
      message: 'Device successfully promoted to primary',
      deviceId: requesterDeviceId,
    });
  } catch (err) {
    next(err);
  }
};
