const { validationResult } = require('express-validator');
const prisma = require('../db/prismaClient');
const { parseCursorParam, makeCursorToken } = require('../utils/pagination');

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

exports.createConversation = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const otherId = req.body.participantId;
    if (!otherId) return res.status(400).json({ message: 'participantId required' });
    if (otherId === userId) return res.status(400).json({ message: 'cannot create conversation with self' });

    const recipientKeys = await prisma.identityKey.findUnique({
      where: { userId: otherId }
    });

    if (!recipientKeys) {
      return res.status(400).json({ 
        message: 'Recipient has not set up E2EE keys yet. Cannot start secure chat.' 
      });
    }

    const [a, b] = orderPair(userId, otherId);

    // Explicitly prevent recreating an existing direct conversation
    const existingConv = await prisma.conversation.findUnique({
      where: { participantAId_participantBId: { participantAId: a, participantBId: b } },
    });

    if (existingConv) {
      return res.status(409).json({ 
        message: 'A conversation already exists with this user.',
        conversationId: existingConv.id
      });
    }

    // Create the new conversation
    const conv = await prisma.conversation.create({
      data: {
        type: 'DIRECT',
        participantAId: a,
        participantBId: b,
        participants: {
          create: [
            { userId: a, role: 'MEMBER' },
            { userId: b, role: 'MEMBER' },
          ],
        },
      },
    });

    const io = req.app.get('io');
    if (io) {
       // Emit to both users so their UI instantly shows the new chat window in real-time
       io.to(`user:${a}`).emit('conversation.created', { conversation: conv });
       io.to(`user:${b}`).emit('conversation.created', { conversation: conv });
    }

    return res.status(201).json(conv);
  } catch (err) {
    next(err);
  }
};


exports.listConversations = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cursorParam = req.query.cursor;
    const parsedCursor = parseCursorParam(cursorParam); 

    // Step 1: Collect conversation IDs
    const participantRows = await prisma.participant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const groupConvIds = participantRows.map((p) => p.conversationId);

    const mainWhereOr = [
      { participantAId: userId },
      { participantBId: userId },
    ];
    if (groupConvIds.length > 0) {
      mainWhereOr.push({ id: { in: groupConvIds } });
    }

    const mainWhere = { OR: mainWhereOr };

    // Apply cursor
    let prismaWhere = mainWhere;
    if (parsedCursor && parsedCursor.id && parsedCursor.createdAt) {
      const cursorUpdatedAt = new Date(parsedCursor.createdAt);
      prismaWhere = {
        AND: [
          mainWhere,
          {
            OR: [
              { updatedAt: { lt: cursorUpdatedAt } },
              { AND: [{ updatedAt: { equals: cursorUpdatedAt } }, { id: { lt: parsedCursor.id } }] },
            ],
          },
        ],
      };
    } else if (parsedCursor && parsedCursor.id && !parsedCursor.createdAt) {
      const cursorConv = await prisma.conversation.findUnique({ where: { id: parsedCursor.id }, select: { id: true, updatedAt: true } });
      if (cursorConv && cursorConv.updatedAt) {
        const cursorUpdatedAt = new Date(cursorConv.updatedAt);
        prismaWhere = {
          AND: [
            mainWhere,
            {
              OR: [
                { updatedAt: { lt: cursorUpdatedAt } },
                { AND: [{ updatedAt: { equals: cursorUpdatedAt } }, { id: { lt: cursorConv.id } }] },
              ],
            },
          ],
        };
      }
    }

    const convs = await prisma.conversation.findMany({
      where: prismaWhere,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        // Include participant user data for DIRECT chat display
        participantA: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        participantB: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        // Fetch the unread count from this user's Participant row
        // AND all participants with user info for GROUP chats
        participants: {
          select: {
            userId: true,
            role: true,
            unreadCount: true,
            user: { select: { id: true, displayName: true, username: true, avatarUrl: true } }
          }
        },
        // Fetch only the single latest message that isn't a KEY_DISTRIBUTION
        messages: {
          where: { contentType: { not: 'SIGNAL_KEY_DISTRIBUTION' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
            createdAt: true
          }
        }
      }
    });

    const hasNext = convs.length > limit;
    const page = convs.slice(0, limit);

    if (page.length === 0) {
      return res.json({ conversations: [], nextCursor: null, hasNext: false });
    }

    // Map Prisma includes to the exact shape the frontend expects
    const enriched = page.map((conv) => {
      const myParticipant = conv.participants.find(p => p.userId === userId);
      const unreadCount = myParticipant ? myParticipant.unreadCount : 0;
      const lastMessage = conv.messages.length > 0 ? conv.messages[0] : null;

      // Clean up internal arrays but keep structured data
      const { messages, ...rest } = conv;

      return {
        ...rest,
        lastMessage,
        unreadCount,
      };
    });

    const nextCursor = hasNext
      ? makeCursorToken({ id: page[page.length - 1].id, createdAt: page[page.length - 1].updatedAt })
      : null;

    return res.json({ conversations: enriched, nextCursor, hasNext });
  } catch (err) {
    next(err);
  }
};

exports.getConversation = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const convId = req.params.id;

    const conv = await prisma.conversation.findUnique({ 
      where: { id: convId },
      include: {
        participantA: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        participantB: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
        participants: {
          select: {
            userId: true,
            role: true,
            unreadCount: true,
            user: { select: { id: true, displayName: true, username: true, avatarUrl: true } }
          }
        },
        messages: {
          where: { contentType: { not: 'SIGNAL_KEY_DISTRIBUTION' } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            conversationId: true,
            content: true,
            contentType: true,
            senderId: true,
            attachmentUrl: true,
            replyToId: true,
            editedAt: true,
            deleted: true,
            createdAt: true
          }
        }
      } 
    });
    
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // Check membership via participants array
    const myParticipant = conv.participants.find(p => p.userId === userId);
    if (!myParticipant) return res.status(403).json({ message: 'Forbidden' });

    const lastMessage = conv.messages.length > 0 ? conv.messages[0] : null;
    const unreadCount = myParticipant.unreadCount;

    // Clean up internal arrays but keep structured data
    const { messages, ...rest } = conv;

    return res.json({
      conversation: rest,
      lastMessage,
      unreadCount,
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        participants: true, 
      }
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const myParticipant = conversation.participants.find(p => p.userId === userId);

    if (!myParticipant) {
      return res.status(403).json({ 
        message: 'Forbidden: You are not a participant in this conversation.' 
      });
    }

    if (conversation.type === 'GROUP') {
      if (myParticipant.role !== 'ADMIN') {
        return res.status(403).json({ 
          message: 'Forbidden: Only group admins can delete this group.' 
        });
      }
    } 
    
    await prisma.conversation.delete({
      where: { id },
    });

    const io = req.app.get('io');
    if (io) {
      conversation.participants.forEach(p => {
         io.to(`user:${p.userId}`).emit('conversation.deleted', { 
            conversationId: id,
            participants: conversation.participants
         });
      });
    }

    return res.status(200).json({ 
      message: 'Conversation deleted successfully.',
      conversationId: id
    });

  } catch (err) {
    return next(err);
  }
};