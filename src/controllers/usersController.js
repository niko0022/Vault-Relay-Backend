const s3Service = require('../services/s3Service');
const { validationResult } = require('express-validator');
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
        
        // Host check: Ensure we only delete files from OUR bucket
        // (Prevents issues if the user previously had a Google/Facebook avatar)
        if (oldUrlObj.hostname.includes(BUCKET)) {
             // .pathname includes the leading slash (e.g., "/avatars/123.jpg")
             // .substring(1) removes it to get "avatars/123.jpg"
             const oldKey = decodeURIComponent(oldUrlObj.pathname.substring(1));

             // Don't delete if it's the same key (unlikely, but safe)
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