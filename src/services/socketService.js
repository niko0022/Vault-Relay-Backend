const prisma = require('../db/prismaClient');
const MessageService = require('../services/messageService'); 
const userSockets = new Map();
const { validateSignalPayload } = require('../utils/signalValidation');

async function notifyFriendsPresence(io, userId, payload) {
  try {
    const rows = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    if (!rows || rows.length === 0) return;

    const friendRooms = rows.map((r) => {
      const friendId = r.requesterId === userId ? r.addresseeId : r.requesterId;
      return `user:${friendId}`;
    });

    if (friendRooms.length > 0) {
      io.to(friendRooms).emit('presence', payload);
    }
  } catch (err) {
    console.error('notifyFriendsPresence error', err);
  }
}


async function attachSocket(io, socket) {
  const userId = socket.user?.id;
  if (!userId) return;

  const socketSet = userSockets.get(userId) || new Set();
  socketSet.add(socket.id);
  userSockets.set(userId, socketSet);

  const userRoom = `user:${userId}`;
  socket.join(userRoom);

  if (socketSet.size === 1) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'ONLINE' },
      });
      const payload = { userId, online: true, lastSeen: null };
      await notifyFriendsPresence(io, userId, payload);

      io.to(userRoom).emit('presence', payload);
    } catch (e) {
      console.error('Failed to set ONLINE status', e);
    }
  } else {
    io.to(userRoom).emit('presence_debug', { userId, activeTabs: socketSet.size });
  }

  console.log(`User ${userId} connected. Active tabs: ${socketSet.size}`);
}


async function onDisconnect(io, socket, reason) {
  const userId = socket.user?.id;
  if (!userId) return;

  const socketSet = userSockets.get(userId);
  if (!socketSet) return;

  socketSet.delete(socket.id);

  if (socketSet.size > 0) {
    userSockets.set(userId, socketSet);
    console.log(`User ${userId} closed a tab. Remaining: ${socketSet.size}`);
    return;
  }

  userSockets.delete(userId);
  console.log(`User ${userId} went OFFLINE.`);

  const lastSeen = new Date();

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'OFFLINE', lastSeen },
    });

    const payload = { userId, online: false, lastSeen: lastSeen.toISOString() };
    await notifyFriendsPresence(io, userId, payload);

    io.to(`user:${userId}`).emit('presence', payload);
  } catch (e) {
    console.error('Failed to set OFFLINE status', e);
  }
}


function registerHandlers(io, socket) {
  
  socket.on('send_message', async (payload, ack) => {
    try {
      const senderId = socket.user.id;
      const { conversationId, content, contentType, attachmentUrl, replyToId } = payload;

      validateSignalPayload(content, contentType);  

      const result = await MessageService.createMessage({
        senderId,
        conversationId,
        content,
        contentType,
        attachmentUrl,
        replyToId,
      });

      // 1. Notify the conversation room (Active Chat)
      io.to(`conv:${conversationId}`).emit('message', {
        message: result.message
      });

      // 2. Notify recipients (Sidebar Preview Update)
      const unreadMap = new Map(result.updatedParticipants.map(p => [p.userId, p.unreadCount]));

      result.recipients.forEach(recipientId => {
        io.to(`user:${recipientId}`).emit('conversation.updated', {
          conversationId,
          lastMessage: result.message,
          unreadCount: unreadMap.get(recipientId),
          updatedAt: new Date().toISOString()
        });
      });

      if (ack) ack({ success: true, message: result.message });

    } catch (err) {
      console.error('send_message error', err);
      if (ack) ack({ success: false, error: err.message });
    }
  });

  socket.on('client:edit_message', async (data) => {
    try {
      const userId = socket.user.id;
      const { messageId, content } = data;

      validateSignalPayload(content, null); // contentType is not available in edit_message
      // Call Service
      const { message, participants } = await MessageService.editMessage(messageId, userId, content);

      // 1. Notify Room (Update the bubble)
      io.to(`conv:${message.conversationId}`).emit('message:edited', message);

      // 2. Notify Participants (Update "Last Message" preview)
      if (participants && participants.length > 0) {
        participants.forEach(pId => {
          io.to(`user:${pId}`).emit('conversation.updated', {
            conversationId: message.conversationId,
            lastMessage: message,
            updatedAt: new Date().toISOString()
          });
        });
      }

    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('client:delete_message', async (data) => {
    try {
      const userId = socket.user.id;
      const { messageId } = data;

      // Call Service
      const { id, conversationId, participants } = await MessageService.deleteMessage(messageId, userId);

      // 1. Notify Room (Remove bubble)
      io.to(`conv:${conversationId}`).emit('message:deleted', {
        id,
        conversationId
      });

      // 2. Notify Participants (Update Preview to "Message deleted")
      if (participants && participants.length > 0) {
        participants.forEach(pId => {
          io.to(`user:${pId}`).emit('conversation.updated', {
            conversationId,
            lastMessage: { content: 'Message deleted', id }, // Placeholder content
            updatedAt: new Date().toISOString()
          });
        });
      }

    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('typing', (payload) => {
    try {
      const userId = socket.user.id;
      const { conversationId, typing } = payload || {};

      if (conversationId) {
        socket.to(`conv:${conversationId}`).emit('typing', { conversationId, userId, typing: !!typing });
      }
    } catch (err) {
      console.error('typing handler error', err);
    }
  });

  socket.on('join_conversation', async (payload, ack) => {
    try {
      const userId = socket.user.id;
      const { conversationId } = payload || {};
      if (!conversationId) throw new Error('conversationId required');

      const participant = await prisma.participant.findFirst({
        where: { conversationId, userId }
      });

      if (!participant) throw new Error('Not authorized to join this conversation');

      await socket.join(`conv:${conversationId}`);

      if (ack) ack({ success: true });
    } catch (err) {
      if (ack) ack({ success: false, error: err.message });
    }
  });

  socket.on('leave_conversation', (payload) => {
    const { conversationId } = payload || {};
    if (conversationId) socket.leave(`conv:${conversationId}`);
  });

  socket.on('read_message', async (payload) => {
    try {
      const userId = socket.user.id;
      const { conversationId, messageId } = payload || {};

      if (!conversationId) return;

      const result = await MessageService.markAsRead({
        userId,
        conversationId,
        lastReadMessageId: messageId
      });

      if (result.marked > 0) {
        // Notify the user (update their own badge count)
        io.to(`user:${userId}`).emit('conversation.updated', {
          conversationId,
          unreadCount: result.newUnreadCount
        });

        // Notify others in the chat (show "Read by X")
        io.to(`conv:${conversationId}`).emit('read_receipt', {
          conversationId,
          userId,
          count: result.marked
        });
      }
    } catch (err) {
      console.error('read_message error', err);
    }
  });
}

module.exports = { attachSocket, onDisconnect, registerHandlers, userSockets };