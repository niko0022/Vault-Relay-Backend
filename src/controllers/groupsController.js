const { validationResult } = require('express-validator');
const prisma = require('../db/prismaClient');

exports.createGroup = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const ownerId = req.user.id;
    const { title, participantIds = [], avatarUrl } = req.body;

    // dedupe and ensure owner included
    const uniqueIds = Array.from(new Set([ownerId, ...(participantIds || [])]));

    // Basic limit check
    if (uniqueIds.length > 100) return res.status(400).json({ message: 'Group size limit exceeded' });

    const conv = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          type: 'GROUP',
          title: title || null,
          avatarUrl: avatarUrl || null,
          participants: {
            create: uniqueIds.map((uid) => ({
              userId: uid,
              role: uid === ownerId ? 'ADMIN' : 'MEMBER',
            })),
          },
        },
        include: { participants: true },
      });
      return created;
    });

    // notify participants via sockets
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io) {
        for (const p of conv.participants) {
          io.to(`user:${p.userId}`).emit('conversation.created', { conversation: conv });
        }
      }
    } catch (e) { console.error('emit fail', e); }

    return res.status(201).json({ conversation: conv });
  } catch (err) {
    next(err);
  }
};

exports.addParticipant = async (req, res, next) => {
  try {
    const convId = req.params.id;
    const actorId = req.user.id;
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ message: 'userId required' });

    // Check conv exists and actor is admin
    const participantActor = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId: convId, userId: actorId } },
      select: { role: true },
    });
    if (!participantActor) return res.status(403).json({ message: 'Forbidden' });
    if (participantActor.role !== 'ADMIN') return res.status(403).json({ message: 'Only admins can add participants' });

    // Create participant (ignore if already exists)
    const created = await prisma.participant.createMany({
      data: [{ conversationId: convId, userId, role: 'MEMBER' }],
      skipDuplicates: true,
    });

    // Optionally increment participant.unreadCount initial value? Usually 0.
    // Notify via sockets
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io) {
        io.to(`user:${userId}`).emit('conversation.invite', { conversationId: convId });
        io.to(`conversation:${convId}`).emit('participant.added', { conversationId: convId, userId });
      }
    } catch (e) { console.error('socket emit failed', e); }

    return res.json({ added: created.count > 0 });
  } catch (err) {
    next(err);
  }
};

exports.removeParticipant = async (req, res, next) => {
  try {
    const convId = req.params.id;
    const actorId = req.user.id;
    const removeId = req.params.userId;

    // actor is admin or removing self
    const actorPart = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId: convId, userId: actorId } },
      select: { role: true },
    });
    if (!actorPart) return res.status(403).json({ message: 'Forbidden' });

    if (actorId !== removeId && actorPart.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Only admins can remove other participants' });
    }

    // remove participant
    const deleted = await prisma.participant.deleteMany({
      where: { conversationId: convId, userId: removeId },
    });

    // Optionally if no participants remain, delete conversation (or archive)
    const remaining = await prisma.participant.count({ where: { conversationId: convId } });
    if (remaining === 0) {
      await prisma.conversation.delete({ where: { id: convId } });
    }

    // socket notify
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io) {
        io.to(`user:${removeId}`).emit('conversation.removed', { conversationId: convId });
        io.to(`conversation:${convId}`).emit('participant.removed', { conversationId: convId, userId: removeId });
      }
    } catch (e) { console.error(e); }

    return res.json({ removed: deleted.count > 0 });
  } catch (err) {
    next(err);
  }
};


exports.listParticipants = async (req, res, next) => {
  try {
    const convId = req.params.id;
    const userId = req.user.id;

    // membership check
    const isParticipant = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId: convId, userId: userId } },
    });
    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    const parts = await prisma.participant.findMany({
      where: { conversationId: convId },
      select: { userId: true, role: true, joinedAt: true, mutedUntil: true },
    });

    return res.json({ participants: parts });
  } catch (err) {
    next(err);
  }
};

