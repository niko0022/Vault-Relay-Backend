const prisma = require('../utils/prismaClient');
const {isBlocked} = require('./blockService')

async function createMessage({senderId, conversationId, content, contentType = 'TEXT', attachmentUrl, relpyToId}) {
    if (!content && !attachmentUrl) {
        throw new Error('Message must have content or attachment');
    }

    const conversation = await prisma.conversation.findUnique({
        where: {id: conversationId},
    });
    if (!conversation) {
        throw new Error('Conversation not found');
    }

    const membership = await prisma.participant.findUnique({
        where: {conversationId_userId: {conversationId, userId: senderId}},
    });
    if (!membership) {
        throw new Error('Forbidden:you are not a participant of the conversation');
    }

    if (conversation.type === 'DIRECT') {
        const otherParticipant = await prisma.participant.findFirst({
            where: {conversationId, userId: {not: senderId}},
        });

        if (otherParticipant) {
            const blocked = await isBlocked(otherParticipant.userId, senderId);
            if (blocked) {
                throw new Error('Forbidden: you are blocked by the recipient');
            }
        }
    }

    const result = await prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
            data: {
                senderId,
                conversationId,
                content,
                contentType,
                attachmentUrl: attachmentUrl || null,
                relpyToId: relpyToId || null,
            },
            include: {sender: 
                {select: {id: true, username: true, avatarUrl: true, displayName: true}}
            },
            include: {relpyToId:
                {select: {id: true, content: true, senderId: true}}
            },
        });
            
        const participant = await tx.participant.finMany({
            where: {conversationId,},
            select: {userId: true},
        });
        
        const recipients = participant.map((p) => p.userId).filter((id) => id !== senderId);

        if (recipients.length > 0) {
            await tx.participant.updateMany({
                where: {conversationId, userId: {in: recipients}},
                data: {unreadcount: {increment: 1}},
            });
        }

        await tx.conversation.update({
            where: {id: conversationId},
            data: {lastMessageId: message.id, updatedAt: new Date()},
        });

        return {
            message: message,
            recipients: recipients,
            updatedParticipants: await tx.participant.findMany({
                where: {conversationId, userId: {in: recipients}},
                select: {userId: true, unreadcount: true},
            }),
        };
    });

    return result;   
}

async function markAsRead({ userId, conversationId, lastReadMessageId = null }) {
  return prisma.$transaction(async (tx) => {
    let dateFilter = {};
    if (lastReadMessageId) {
      const targetMsg = await tx.message.findUnique({
        where: { id: lastReadMessageId },
        select: { createdAt: true, conversationId: true }
      });

      if (!targetMsg || targetMsg.conversationId !== conversationId) {
        throw new Error('Invalid lastReadMessageId: Message not found in this conversation');
      }
      dateFilter = { createdAt: { lte: targetMsg.createdAt } };
    }

    const unreadMessages = await tx.message.findMany({
      where: {
        conversationId,
        senderId: { not: userId }, 
        ...dateFilter,
        receipts: {
          none: { userId }
        }
      },
      select: { id: true }
    });

    const count = unreadMessages.length;

    if (count === 0) {
      const participant = await tx.participant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { unreadCount: true }
      });
      return { marked: 0, newUnreadCount: participant?.unreadCount ?? 0 };
    }

    await tx.messageReceipt.createMany({
      data: unreadMessages.map((msg) => ({
        messageId: msg.id,
        userId
      })),
      skipDuplicates: true 
    });

    const updatedParticipant = await tx.participant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: {
        unreadCount: { decrement: count }
      },
      select: { unreadCount: true }
    });

    let finalCount = updatedParticipant.unreadCount;
    if (finalCount < 0) {
      finalCount = 0;
      await tx.participant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { unreadCount: 0 }
      });
    }

    return { marked: count, newUnreadCount: finalCount };
  });
}

module.exports = {
    createMessage,
    markAsRead,
};