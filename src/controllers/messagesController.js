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

    // check conversation exists
    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // verify user is participant: either participantA/B or Participant table entry
    const isParticipant =
      (conv.participantAId && conv.participantAId === userId) ||
      (conv.participantBId && conv.participantBId === userId) ||
      (await prisma.participant.findFirst({ where: { conversationId: convId, userId } }));

    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    // parse cursor param (supports base64url opaque token or raw id)
    const parsed = parseCursorParam(cursorRaw); // may be {id} or {id, createdAt}
    let whereCursor = undefined;

    if (parsed && parsed.createdAt) {
      // full cursor supplied
      whereCursor = olderThanCursorWhere(parsed);
    } else if (parsed && parsed.id) {
      // raw id fallback — need createdAt for keyset predicate
      const cursorMsg = await prisma.message.findUnique({ where: { id: parsed.id }, select: { id: true, createdAt: true } });
      if (cursorMsg) {
        whereCursor = olderThanCursorWhere({ id: cursorMsg.id, createdAt: cursorMsg.createdAt });
      }
    }

    // Base where: conversationId
    const baseWhere = { conversationId: convId };
    const where = whereCursor ? { AND: [baseWhere, whereCursor] } : baseWhere;

    // fetch newest first (desc) then reverse to oldest->newest for client
    const messages = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // +1 to detect hasNext
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

    // return messages with explicit hasNext flag
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