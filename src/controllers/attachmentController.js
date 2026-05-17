const prisma = require('../db/prismaClient');
const s3Service = require('../services/s3Service');

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

exports.getUploadUrl = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;

    // Verify conversation exists
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // Verify membership
    const membership = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!membership) return res.status(403).json({ message: 'Forbidden' });

    const { uploadUrl, key, publicUrl, expiresIn } = await s3Service.getAttachmentPresignedUrl({
      conversationId,
    });

    return res.json({ uploadUrl, key, publicUrl, expiresIn, maxSize: MAX_ATTACHMENT_SIZE });
  } catch (err) {
    return next(err);
  }
};
