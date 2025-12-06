const { validationResult, matchedData } = require('express-validator');
const prisma = require('../db/prismaClient');
const { olderThanCursorWhere, parseCursorParam, makeCursorToken } = require('../utils/pagination');
const { isBlocked } = require('../services/block.service');


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
    const { content, contentType = 'TEXT', attachmentUrl } = req.body;

    if (!content && !attachmentUrl) {
      return res.status(400).json({ message: 'content or attachmentUrl required' });
    }

    // ensure conv exists
    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // membership check
    const isParticipant =
      (conv.participantAId && conv.participantAId === userId) ||
      (conv.participantBId && conv.participantBId === userId) ||
      (await prisma.participant.findFirst({ where: { conversationId: convId, userId } }));
    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    if (conv.type === 'DIRECT') {
      const otherUserId = 
        conv.participantAId === userId ? conv.participantBId
        : conv.participantBId === userId ? conv.participantAId
        : null;
      
      if (!otherUserId) {
        return res.status(500).json({ message: 'Forbidden' });
      }

      if (await isBlocked(userId, otherUserId)) {
        return res.status(403).json({ message: 'Cannot send message: one of the users has blocked the other' });
      }
    }
    
    const matched = matchedData(req, { includeOptionals: true, locations: ['body'] });
    // matched.content is the sanitized/normalized content if you applied sanitizers in route validators
    let safeContent = typeof matched.content === 'string' ? matched.content : (content || '');

    // As a safety fallback, enforce max length server-side in case missed by validators:
    if (typeof safeContent === 'string' && safeContent.length > 5000) {
      safeContent = safeContent.slice(0, 5000);
    }


    // TRANSACTION: create message, increment unread for other participants, update conversation
    const result = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          conversationId: convId,
          senderId: userId,
          content: safeContent,
          contentType,
          attachmentUrl: attachmentUrl || null,
        },
      });

      // get participants for this conversation
      let participantRows = await tx.participant.findMany({
        where: { conversationId: convId },
        select: { userId: true },
      });

      // Fallback: if there are no participant rows (old data), derive from participantA/B
      if (participantRows.length === 0) {
        const ids = [];
        if (conv.participantAId && conv.participantAId !== userId) ids.push(conv.participantAId);
        if (conv.participantBId && conv.participantBId !== userId && conv.participantBId !== conv.participantAId) ids.push(conv.participantBId);
        participantRows = ids.map((u) => ({ userId: u }));
      }

      // recipient IDs = participants excluding sender
      const recipientIds = participantRows.map((p) => p.userId).filter((id) => id !== userId);

      // increment unreadCount for each recipient (single updateMany)
      if (recipientIds.length > 0) {
        await tx.participant.updateMany({
          where: {
            conversationId: convId,
            userId: { in: recipientIds },
          },
          data: {
            unreadCount: { increment: 1 },
          },
        });
      }

      // update conversation lastMessageId + updatedAt
      await tx.conversation.update({
        where: { id: convId },
        data: { lastMessageId: msg.id, updatedAt: new Date() },
      });

      // fetch updated unreadCounts for recipients so we can include them in socket events
      const updatedParticipants = recipientIds.length
        ? await tx.participant.findMany({
            where: { conversationId: convId, userId: { in: recipientIds } },
            select: { userId: true, unreadCount: true },
          })
        : [];

      return { msg, recipientIds, updatedParticipants };
    });

    // Socket.IO pseudo-code: emit per-recipient unread counts and message.created
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io) {
        // map for fast lookup
        const unreadMap = new Map(result.updatedParticipants.map((p) => [p.userId, p.unreadCount]));

        // emit message.created for each recipient (and optionally for sender)
        for (const rid of result.recipientIds) {
          io.to(`user:${rid}`).emit('message.created', {
            conversationId: convId,
            message: result.msg,
            unreadCount: unreadMap.get(rid) ?? null,
          });
        }

        // update conversation list for participants (sender too)
        // send updated conversation summary to participants (sender & recipients)
        const participantsToNotify = Array.from(new Set([...result.recipientIds, req.user.id]));
        for (const uid of participantsToNotify) {
          const unreadForUser = uid === req.user.id ? 0 : (unreadMap.get(uid) ?? 0);
          io.to(`user:${uid}`).emit('conversation.updated', {
            conversationId: convId,
            lastMessage: {
              id: result.msg.id,
              content: result.msg.content,
              contentType: result.msg.contentType,
              senderId: result.msg.senderId,
              createdAt: result.msg.createdAt,
            },
            // each user cares about *their* unread count (0 for sender)
            unreadCount: unreadForUser,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    } catch (emitErr) {
      console.error('Socket emit failed:', emitErr);
    }

    return res.status(201).json({ message: result.msg, recipients: result.recipientIds });
  } catch (err) {
    next(err);
  }
};


exports.markRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const convId = req.params.conversationId;
    const lastReadMessageId = req.body.lastReadMessageId ? String(req.body.lastReadMessageId) : null;

    // ensure conv exists
    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // verify participant membership
    const isParticipant =
      (conv.participantAId && conv.participantAId === userId) ||
      (conv.participantBId && conv.participantBId === userId) ||
      (await prisma.participant.findFirst({ where: { conversationId: convId, userId } }));

    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    let targetMessagesWhere = {
      conversationId: convId,
      senderId: { not: userId },
    };


    if (lastReadMessageId) {
      // validate the provided message belongs to the conversation
      const lastMsg = await prisma.message.findUnique({ where: { id: lastReadMessageId }, select: { id: true, createdAt: true, conversationId: true } });
      if (!lastMsg || lastMsg.conversationId !== convId) {
        return res.status(400).json({ message: 'Invalid lastReadMessageId' });
      }
      // messages up to that createdAt (inclusive)
      targetMessagesWhere.createdAt = { lte: lastMsg.createdAt };
    }

    // Transaction: find message ids to mark, create receipts (skip duplicates), adjust participant.unreadCount
    const result = await prisma.$transaction(async (tx) => {
      // normalize lastRead for parameterization (null when not provided)
      const lastRead = lastReadMessageId ? String(lastReadMessageId) : null;

      // 1) find message ids to mark as read
      // Note: we cannot use targetMessagesWhere directly in a raw query, so we inline the conditions
      // Also note: we exclude messages that already have a receipt for this user (idempotency)
      const idsRows = await tx.$queryRaw`
        SELECT m.id
        FROM "Message" m
        WHERE m."conversationId" = ${convId}
          AND m."senderId" <> ${userId}
          AND (${lastRead} IS NULL OR m."createdAt" <= (SELECT "createdAt" FROM "Message" WHERE id = ${lastRead}))
          AND NOT EXISTS (
            SELECT 1 FROM "MessageReceipt" r
            WHERE r."messageId" = m.id
              AND r."userId" = ${userId}
          )
        ORDER BY m."createdAt" ASC, m.id ASC
      `;

      // normalized ids array
      const messageIds = (Array.isArray(idsRows) ? idsRows.map(r => r.id) : []).filter(Boolean);

      if (messageIds.length === 0) {
        const participantRow = await tx.participant.findUnique({
          where: { conversationId_userId: { conversationId: convId, userId } },
          select: { unreadCount: true },
        });
        return { marked: 0, newUnreadCount: participantRow?.unreadCount ?? 0 };
      }

      // 2) create receipts for those messageIds (skipDuplicates prevents unique constraint errors if any race)
      const now = new Date();
      const receiptsData = messageIds.map((mid) => ({ messageId: mid, userId, readAt: now }));

      // createMany returns { count } when supported; skipDuplicates prevents unique constraint errors
      const created = await tx.messageReceipt.createMany({ data: receiptsData, skipDuplicates: true });

      // Prefer actual inserted count when available (handles races properly)
      const marked = (created && typeof created.count === 'number') ? created.count : messageIds.length;

      // 3) adjust Participant.unreadCount for this user (clamp >= 0)
      const participantRow = await tx.participant.findUnique({
        where: { conversationId_userId: { conversationId: convId, userId } },
        select: { unreadCount: true },
      });

      const current = participantRow?.unreadCount ?? 0;
      const newCount = Math.max(0, current - marked);

      await tx.participant.update({
        where: { conversationId_userId: { conversationId: convId, userId } },
        data: { unreadCount: newCount },
      });

      return { marked, newUnreadCount: newCount };
    });

    // emit socket events if needed
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && result.marked > 0) {
        io.to(`conversation:${convId}`).emit('messages.read', { conversationId: convId, userId, marked: result.marked });
        io.to(`user:${userId}`).emit('conversation.updated', { conversationId: convId, unreadCount: result.newUnreadCount });
      }
    } catch (emitErr) {
      console.error('Socket emit failed', emitErr);
    }

    return res.json({ marked: result.marked, unreadCount: result.newUnreadCount });
  } catch (err) {
    next(err);
  }
};
