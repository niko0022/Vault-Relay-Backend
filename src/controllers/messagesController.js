const { validationResult } = require('express-validator');
const prisma = require('../db/prismaClient');
const { olderThanCursorWhere, parseCursorParam, makeCursorToken } = require('../utils/pagination');
const MessageService = require('../services/messageService');

exports.getMessages = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const convId = req.params.conversationId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const cursorRaw = req.query.cursor;

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // Helper to check participation (Works for both Direct and Group)
    const isParticipant = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId: convId, userId } }
    });

    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    const parsed = parseCursorParam(cursorRaw);
    let whereCursor = undefined;

    if (parsed && parsed.createdAt) {
      whereCursor = olderThanCursorWhere(parsed);
    } else if (parsed && parsed.id) {
      const cursorMsg = await prisma.message.findUnique({ where: { id: parsed.id }, select: { id: true, createdAt: true } });
      if (cursorMsg) {
        whereCursor = olderThanCursorWhere({ id: cursorMsg.id, createdAt: cursorMsg.createdAt });
      }
    }

    const baseWhere = { conversationId: convId };
    const where = whereCursor ? { AND: [baseWhere, whereCursor] } : baseWhere;

    const messages = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        content: true,
        contentType: true, // Frontend needs this to know IF it should decrypt
        senderId: true,
        attachmentUrl: true,
        replyToId: true,
        editedAt: true,
        deleted: true,
        createdAt: true,
      },
    });

    const hasNext = messages.length > limit;
    let page = messages.slice(0, limit).reverse();

    // For GROUP conversations, inject the latest SIGNAL_KEY_DISTRIBUTION message
    // from every sender. This guarantees that late joiners (or clients that cleared
    // their cache) always receive the Sender Key needed to decrypt the history.
    if (conv.type === 'GROUP') {
      try {
        const latestSkdms = await prisma.message.findMany({
          where: {
            conversationId: convId,
            contentType: 'SIGNAL_KEY_DISTRIBUTION'
          },
          distinct: ['senderId'],
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
            createdAt: true
          }
        });

        // Only inject keys that aren't already in the page
        const existingIds = new Set(page.map(m => m.id));
        const keysToInject = latestSkdms.filter(k => !existingIds.has(k.id));
        if (keysToInject.length > 0) {
          page = [...keysToInject, ...page];
        }
      } catch (skdmErr) {
        console.error('[Signal] Failed to inject SKDMs:', skdmErr);
        // Non-fatal — continue with the original page
      }
    }

    const nextCursor = hasNext
      ? makeCursorToken({ id: messages[limit - 1].id, createdAt: messages[limit - 1].createdAt })
      : null;

    return res.json({ messages: page, nextCursor, hasNext });
  } catch (err) {
    next(err);
  }
};

exports.sendMessage = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const convId = req.params.conversationId;
    const { content, contentType, attachmentUrl, replyToId } = req.body;

    // SIGNAL CHANGE: Detect if this is a "Control Message"
    const isKeyDistribution = contentType === 'SIGNAL_KEY_DISTRIBUTION';

    const result = await MessageService.createMessage({
      senderId: userId,
      conversationId: convId,
      content,
      contentType, // Pass this through!
      attachmentUrl,
      replyToId
    });

    // Socket Emissions
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${convId}`).emit('message', { message: result.message });
      if (!isKeyDistribution) {
        const unreadMap = new Map(result.updatedParticipants.map(p => [p.userId, p.unreadCount]));

        result.recipients.forEach(uid => {
          io.to(`user:${uid}`).emit('conversation.updated', {
            conversationId: convId,
            lastMessage: result.message,
            unreadCount: unreadMap.get(uid),
            updatedAt: new Date().toISOString()
          });
        });
      }
    }

    return res.status(201).json(result.message);
  } catch (err) {
    next(err);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const convId = req.params.conversationId;
    const lastReadMessageId = req.body.lastReadMessageId ? String(req.body.lastReadMessageId) : null;

    const membership = await prisma.participant.findUnique({
      where: { conversationId_userId: { conversationId: convId, userId } }
    });
    if (!membership) return res.status(403).json({ message: 'Forbidden' });

    const result = await MessageService.markAsRead({
      userId,
      conversationId: convId,
      lastReadMessageId
    });

    const io = req.app.get('io');
    if (io && result.marked > 0) {
      // Notify the user who read it (to clear their badge)
      io.to(`user:${userId}`).emit('conversation.updated', {
        conversationId: convId,
        unreadCount: result.newUnreadCount
      });

      io.to(`conv:${convId}`).emit('messages.read', {
        conversationId: convId,
        userId,
        markedCount: result.marked
      });
    }

    return res.json(result);
  } catch (err) {
    if (err.message.includes('Invalid lastReadMessageId')) {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
};

exports.editMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    // In Signal, 'content' here is the NEW Ciphertext
    const { content } = req.body;

    const { message, participants } = await MessageService.editMessage(messageId, userId, content);

    const io = req.app.get('io');
    if (io) {
      // FIX: Added 'conv:' prefix. 
      // Previously: io.to(message.conversationId) <- THIS WOULD FAIL
      io.to(`conv:${message.conversationId}`).emit('message:edited', message);

      participants.forEach(participantId => {
        io.to(`user:${participantId}`).emit('conversation.updated', {
          conversationId: message.conversationId,
          lastMessage: message // Frontend must decrypt this new content
        });
      });
    }

    return res.status(200).json(message);

  } catch (err) {
    return next(err);
  }
};

exports.deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const { id: deletedId, conversationId, participants } = await MessageService.deleteMessage(messageId, userId);

    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conversationId}`).emit('message:deleted', { id: deletedId, conversationId });

      participants.forEach(participantId => {
        io.to(`user:${participantId}`).emit('conversation.updated', {
          conversationId: conversationId,
          lastMessage: {
            id: deletedId,
            deleted: true, // Signal frontend needs this flag
            createdAt: new Date()
          }
        });
      });
    }
    return res.status(200).json({ message: 'Message deleted successfully', id: deletedId });
  } catch (err) {
    return next(err);
  }
};