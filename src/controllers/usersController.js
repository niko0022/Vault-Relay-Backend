const s3Service = require('../services/s3Service');
const { validationResult } = require('express-validator');
const path = require('path');
const prisma = require('../db/prismaClient');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024; // optionally check (S3 head returns ContentLength)

exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    // select safe fields only
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

    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    const contentType = String(req.body.contentType).toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) {
      return res.status(400).json({ message: 'Invalid contentType' });
    }

    const originalName = req.body.originalName;
    const { uploadUrl, key, expiresIn } = await s3Service.getPresignedUploadUrl({ userId, contentType, originalName });

    return res.json({ uploadUrl, key, expiresIn });
  } catch (err) {
    return next(err);
  }
};


exports.completeAvatarUpload = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    const key = req.body.key;

    // HEAD the object to verify it exists & retrieve metadata
    let head;
    try {
      head = await s3Service.headObject(key);
    } catch (err) {
      // object not found or access denied
      return res.status(400).json({ message: 'Uploaded object not found or inaccessible' });
    }

    const contentType = head.ContentType || '';
    const contentLength = head.ContentLength || 0;
    if (!ALLOWED_MIME.has(contentType)) {
      return res.status(400).json({ message: 'Uploaded file type not allowed' });
    }
    if (contentLength > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({ message: 'Uploaded file too large' });
    }

    // Build final public URL (prefer CloudFront if configured)
    const cloudfront = process.env.CLOUDFRONT_URL && process.env.CLOUDFRONT_URL.trim();
    let publicUrl;
    if (cloudfront) {
      // ensure no trailing slash on CLOUDFRONT_URL
      publicUrl = `${cloudfront.replace(/\/$/, '')}/${key}`;
    } else {
      // S3 URL pattern (region aware)
      const region = process.env.AWS_REGION;
      const bucket = process.env.S3_BUCKET;
      publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key)}`;
    }

    // Remove old avatar in S3 if it was uploaded previously and looks like our key
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    if (user && user.avatarUrl) {
      // try to extract a key that belongs to our bucket (simple heuristic)
      try {
        const existingKey = (() => {
          if (!user.avatarUrl) return null;
          const cf = process.env.CLOUDFRONT_URL;
          if (cf && user.avatarUrl.startsWith(cf)) {
            // url like https://cdn/.../<key>
            return user.avatarUrl.slice(cf.length + 1);
          }
          // s3 url form
          // https://bucket.s3.region.amazonaws.com/<key>
          const s3prefix = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;
          if (user.avatarUrl.startsWith(s3prefix)) {
            return decodeURIComponent(user.avatarUrl.slice(s3prefix.length));
          }
          return null;
        })();

        if (existingKey && existingKey !== key) {
          // attempt delete (best effort)
          try {
            await s3Service.deleteObject(existingKey);
          } catch (e) {
            // log and continue
            console.warn('Failed to delete previous avatar from S3', e);
          }
        }
      } catch (e) {
        // ignore extraction errors
        console.warn('Could not parse previous avatarUrl for deletion', e);
      }
    }

    // update user
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
