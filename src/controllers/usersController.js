const s3Service = require('../services/s3Service');
const { validationResult, matchedData } = require('express-validator');
const prisma = require('../db/prismaClient');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
// 4MB Limit (Make sure this matches your frontend limit)
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;

const BUCKET = process.env.AWS_S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;

exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        username: true,
        avatarUrl: true,
        bio: true,
        status: true,
        lastSeen: true,
        createdAt: true,
        friendCode: true,
      },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
};

exports.getAvatarUploadUrl = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const contentType = String(req.body.contentType).toLowerCase();
    const originalName = req.body.originalName;

    // 1. Validate File Type
    if (!ALLOWED_MIME.has(contentType)) {
      return res.status(400).json({ message: 'Invalid contentType. Allowed: JPEG, PNG, WEBP' });
    }

    // 2. Generate Presigned URL
    const { uploadUrl, key, expiresIn } = await s3Service.getPresignedUploadUrl({
      userId,
      contentType,
      originalName
    });

    return res.json({ uploadUrl, key, expiresIn });
  } catch (err) {
    return next(err);
  }
};

exports.completeAvatarUpload = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const key = req.body.key;

    // 1. Verify existence in S3 (Crucial Security Step)
    let head;
    try {
      head = await s3Service.headObject(key);
    } catch (err) {
      return res.status(400).json({ message: 'File not found in S3. Did the upload succeed?' });
    }

    // 2. Validate Metadata (Type & Size)
    const contentType = head.ContentType || '';
    const contentLength = head.ContentLength || 0;

    if (!ALLOWED_MIME.has(contentType)) {
      // Optional: Delete the invalid file from S3 immediately
      await s3Service.deleteObject(key);
      return res.status(400).json({ message: 'File type validation failed' });
    }

    if (contentLength > MAX_FILE_SIZE_BYTES) {
      await s3Service.deleteObject(key);
      return res.status(400).json({ message: 'File is too large' });
    }

    const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

    // 4. Handle Cleanup: Delete the User's OLD avatar if it exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true }
    });

    if (user && user.avatarUrl) {
      try {
        const oldUrlObj = new URL(user.avatarUrl);
        if (oldUrlObj.hostname.includes(BUCKET)) {
          const oldKey = decodeURIComponent(oldUrlObj.pathname.substring(1));

          if (oldKey && oldKey !== key) {
            await s3Service.deleteObject(oldKey);
            console.log(`Deleted old avatar: ${oldKey}`);
          }
        }
      } catch (e) {
        console.warn('Could not parse/delete old avatar URL:', e.message);
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: publicUrl },
      select: { id: true, avatarUrl: true },
    });

    return res.json({ avatarUrl: updated.avatarUrl });

  } catch (err) {
    return next(err);
  }
};

exports.deleteAvatar = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // 1. Find the user to get the current URL
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true }
    });

    if (!user || !user.avatarUrl) {
      return res.status(400).json({ message: 'No avatar to delete' });
    }

    // 2. Extract S3 Key and Delete from S3
    const BUCKET = process.env.AWS_S3_BUCKET_NAME;
    try {
      const urlObj = new URL(user.avatarUrl);
      if (urlObj.hostname.includes(BUCKET)) {
        // Remove leading slash to get key "avatars/..."
        const key = decodeURIComponent(urlObj.pathname.substring(1));
        await s3Service.deleteObject(key);
      }
    } catch (err) {
      console.warn('Failed to delete S3 object during avatar removal:', err);
      // We continue anyway to remove the reference from DB
    }

    // 3. Update Database (Set to NULL)
    await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null }
    });

    return res.json({ message: 'Avatar deleted successfully' });

  } catch (err) {
    return next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;

    const data = matchedData(req, { locations: ['body'] });

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    try {
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          username: true,
          displayName: true,
        }
      });
      return res.json({ message: 'Profile updated successfully', user: updatedUser });
    } catch (dbError) {
      // Prisma error code P2002 means Unique constraint failed
      if (dbError.code === 'P2002' && dbError.meta && dbError.meta.target.includes('username')) {
        return res.status(400).json({ message: 'This username is already taken. Please choose another one.' });
      }
      throw dbError;
    }
  } catch (err) {
    return next(err);
  }
};

exports.deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.avatarUrl) {
      const avatarKey = extractS3KeyFromUrl(user.avatarUrl);
      await s3Service.deleteObject(avatarKey);
    }

    const messagesWithFiles = await prisma.message.findMany({
      where: { senderId: userId, attachmentUrl: { not: null } }
    });

    for (let msg of messagesWithFiles) {
      const fileKey = extractS3KeyFromUrl(msg.attachmentUrl);
      await s3Service.deleteObject(fileKey);
    }

    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      select: { id: true, requesterId: true, addresseeId: true }
    });

    await prisma.user.delete({
      where: { id: userId }
    });

    const io = req.app.get("io");

    if (io) {
      for (let f of friendships) {
        const friendId = f.requesterId === userId ? f.addresseeId : f.requesterId;
        io.to(`user:${friendId}`).emit("friendHandler.removed", { friendshipId: f.id });
      }
    }

    return res.status(200).json({ message: "Account deleted successfully" });
  } catch (err) {
    return next(err);
  }
};
