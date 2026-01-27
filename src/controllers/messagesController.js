const { validationResult, matchedData } = require('express-validator');
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

    const isParticipant =
      (conv.participantAId && conv.participantAId === userId) ||
      (conv.participantBId && conv.participantBId === userId) ||
      (await prisma.participant.findFirst({ where: { conversationId: convId, userId } }));

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
        contentType: true,
        senderId: true,
        attachmentUrl: true,
        replyToId: true,
        editedAt: true,
        deleted: true,
        createdAt: true,
      },
    });

    const hasNext = messages.length > limit;
    const page = messages.slice(0, limit).reverse(); // oldest -> newest

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

    const result = await MessageService.createMessage({
      senderId: userId,
      conversationId: convId,
      content,
      contentType,
      attachmentUrl,
      replyToId
    });

    // Socket Emissions
    const io = req.app.get('io');
    if (io) {
        io.to(`conv:${convId}`).emit('message', { message: result.message });
        
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

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });


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
      io.to(`user:${userId}`).emit('conversation.updated', { 
        conversationId: convId, 
        unreadCount: result.newUnreadCount 
      });
      
      io.to(`conversation:${convId}`).emit('messages.read', {
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
    const { content } = req.body;

    // Destructure the result
    const { message, participants } = await MessageService.editMessage(messageId, userId, content);

    // Broadcast via Socket
    const io = req.app.get('io'); 
    if (io) {
        // 1. Update the Chat Room (The bubbles)
        io.to(message.conversationId).emit('message:edited', message);

        // 2. Update the Chat List (The preview on the left side)
        participants.forEach(participantId => {
            io.to(`user:${participantId}`).emit('conversation.updated', {
                conversationId: message.conversationId,
                lastMessage: message // Send the updated content
            });
        });
    }

    // Send only the message back to the REST client
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
        // 1. Remove bubble from room
        io.to(conversationId).emit('message:deleted', { id: deletedId, conversationId });

        // 2. Update Chat List (Optional: Force a refresh or show "Message deleted")
        participants.forEach(participantId => {
             io.to(`user:${participantId}`).emit('conversation.updated', {
                conversationId: conversationId,
                // We send a partial message object to indicate the update
                lastMessage: { 
                    id: deletedId, 
                    content: 'Message deleted', // Or handle logic to fetch the *previous* message
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