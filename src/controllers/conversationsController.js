const { validationResult } = require('express-validator');
const prisma = require('../db/prismaClient');
const { parseCursorParam, makeCursorToken } = require('../utils/pagination');

// helper ordering (deterministic pair order)
function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}


exports.getOrCreateConversation = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const userId = req.user.id;
    const otherId = req.body.participantId;
    if (!otherId) return res.status(400).json({ message: 'participantId required' });
    if (otherId === userId) return res.status(400).json({ message: 'cannot create conversation with self' });

    const [a, b] = orderPair(userId, otherId);

    // Try to find existing conversation (ordered pair)
    let conv = await prisma.conversation.findUnique({
      where: { participantAId_participantBId: { participantAId: a, participantBId: b } },
    });

    if (!conv) {
      // create conversation and two Participant rows atomically
      // Pattern: try create in transaction -> if unique constraint hit (race), fetch again
      try {
        conv = await prisma.$transaction(async (tx) => {
          const created = await tx.conversation.create({
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
          return created;
        });
      } catch (err) {
        // possible race (unique constraint). Try to fetch again; if still missing, rethrow.
        conv = await prisma.conversation.findUnique({
          where: { participantAId_participantBId: { participantAId: a, participantBId: b } },
        });
        if (!conv) throw err;
      }
    }

    return res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
};


exports.listConversations = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cursorParam = req.query.cursor;

    // parse cursor using shared helper that supports base64url JSON tokens or raw id
    const parsedCursor = parseCursorParam(cursorParam); // may return { id, createdAt } or { id } or null

    // Step 1: collect conversation IDs where user participates (group convs)
    const participantRows = await prisma.participant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const groupConvIds = participantRows.map((p) => p.conversationId);

    // Build main where: user is participantA or participantB OR (if any) participant in participants table
    const mainWhereOr = [
      { participantAId: userId },
      { participantBId: userId },
    ];
    if (groupConvIds.length > 0) {
      mainWhereOr.push({ id: { in: groupConvIds } });
    }

    const mainWhere = { OR: mainWhereOr };

    // Apply cursor (keyset) by updatedAt + id
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
      // fallback: client provided raw id — fetch conversation's updatedAt for keyset
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

    // Fetch conversations with one extra to detect next page
    const convs = await prisma.conversation.findMany({
      where: prismaWhere,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasNext = convs.length > limit;
    const page = convs.slice(0, limit);
    const convIds = page.map((c) => c.id);

    // If we have no conversations on this page, return early
    if (convIds.length === 0) {
      return res.json({ conversations: [], nextCursor: null, hasNext: false });
    }


    // 1) latest messages: DISTINCT ON per conversation
    const lastMessagesRows = await prisma.$queryRaw`
      SELECT DISTINCT ON (m."conversationId")
        m."conversationId",
        m.id,
        m.content,
        m."contentType",
        m."senderId",
        m."createdAt"
      FROM "Message" m
      WHERE m."conversationId" = ANY(${convIds})
      ORDER BY m."conversationId", m."createdAt" DESC, m.id DESC
    `;

    const lastMessageMap = new Map();
    for (const row of lastMessagesRows) {
      lastMessageMap.set(row.conversationId, {
        id: row.id,
        content: row.content,
        contentType: row.contentType,
        senderId: row.senderId,
        createdAt: row.createdAt,
      });
    }

    const unreadRows = await prisma.$queryRaw`
      SELECT m."conversationId", COUNT(*)::int AS count
      FROM "Message" m
      WHERE m."conversationId" = ANY(${convIds})
        AND m."senderId" <> ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "MessageReceipt" r
          WHERE r."messageId" = m.id
            AND r."userId" = ${userId}
        )
      GROUP BY m."conversationId"
    `;

    const unreadMap = new Map();
    for (const r of unreadRows) {
      unreadMap.set(r.conversationId, Number(r.count));
    }

    // Compose final enriched conversation objects (attach lastMessage + unreadCount)
    const enriched = page.map((conv) => {
      const last = lastMessageMap.get(conv.id) || null;
      const unreadCount = unreadMap.get(conv.id) || 0;
      return {
        ...conv,
        lastMessage: last,
        unreadCount,
      };
    });

    // Build nextCursor (opaque)
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

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    // Strict membership check
    const isDirectParticipant =
      (conv.participantAId && conv.participantAId === userId) ||
      (conv.participantBId && conv.participantBId === userId);

    let isParticipant = Boolean(isDirectParticipant);

    if (!isParticipant) {
      // If not a direct participant, check Participant table (group conversation)
      const participant = await prisma.participant.findFirst({
        where: { conversationId: convId, userId },
        select: { id: true },
      });
      isParticipant = Boolean(participant);
    }

    if (!isParticipant) return res.status(403).json({ message: 'Forbidden' });

    // Fetch latest message for this conversation (single-row query)
    const lastMessageRows = await prisma.$queryRaw`
      SELECT
        m.id,
        m."conversationId",
        m.content,
        m."contentType",
        m."senderId",
        m."attachmentUrl" as "attachmentUrl",
        m."replyToId",
        m."editedAt",
        m."deleted",
        m."createdAt"
      FROM "Message" m
      WHERE m."conversationId" = ${convId}
      ORDER BY m."createdAt" DESC, m.id DESC
      LIMIT 1
    `;

    const lastMessage = (Array.isArray(lastMessageRows) && lastMessageRows.length > 0)
      ? lastMessageRows[0]
      : null;

    const unreadRows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "Message" m
      WHERE m."conversationId" = ${convId}
        AND m."senderId" <> ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "MessageReceipt" r
          WHERE r."messageId" = m.id
            AND r."userId" = ${userId}
        )
    `;

    const unreadCount = (Array.isArray(unreadRows) && unreadRows.length > 0)
      ? Number(unreadRows[0].count)
      : 0;

    return res.json({
      conversation: conv,
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

    return res.status(200).json({ 
      message: 'Conversation deleted successfully.',
      conversationId: id
    });

  } catch (err) {
    return next(err);
  }
};