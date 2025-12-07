const prisma = require('../db/prismaClient'); 
const { isBlocked } = require('./block.service'); 
const MessageService = require('./messageService');

const ONLINE_KEY = 'online';

const userSockets = new Map(); 

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

  // 1. Update In-Memory Map
  const socketSet = userSockets.get(userId) || new Set();
  socketSet.add(socket.id);
  userSockets.set(userId, socketSet);

  // 2. Join Personal Room
  const userRoom = `user:${userId}`;
  socket.join(userRoom);

  // 3. Check if this is the FIRST connection (User coming Online)
  if (socketSet.size === 1) {
    try {
      // Update DB
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'ONLINE' },
      });
      
      // Notify Friends
      const payload = { userId, online: true, lastSeen: null };
      await notifyFriendsPresence(io, userId, payload);
      
      // Notify the user's own room (useful for UI updates on other devices)
      io.to(userRoom).emit('presence', payload);

    } catch (e) {
      console.error('Failed to set ONLINE status', e);
    }
  } else {
    // 4. Debug/UI: Notify local sockets about tab count
    // for debugging "Why am I still online?
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

  // 1. Case: User still has other tabs open
  if (socketSet.size > 0) {
    userSockets.set(userId, socketSet);
    console.log(`User ${userId} closed a tab. Remaining: ${socketSet.size}`);
    return; // STOP HERE. Do not update DB. Do not notify friends.
  }

  // 2. Case: User is truly Offline (0 tabs)
  userSockets.delete(userId);
  console.log(`User ${userId} went OFFLINE.`);

  const lastSeen = new Date();

  try {
    // Update DB
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'OFFLINE', lastSeen },
    });

    // Notify Friends
    const payload = { userId, online: false, lastSeen: lastSeen.toISOString() };
    await notifyFriendsPresence(io, userId, payload);
    
    // Notify own room (in case of race conditions or lingering connections)
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

      const result = await MessageService.createMessage({
        senderId,
        conversationId,
        content,
        contentType,
        attachmentUrl,
        replyToId,
      });

      io.to(`conv:${conversationId}`).emit('message', { 
        message: result.message 
      });

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

      // Use the Shared Service
      const result = await MessageService.markAsRead({
        userId,
        conversationId,
        lastReadMessageId: messageId
      });

      // Emit updates if changes happened
      if (result.marked > 0) {
         // Notify the user (update badge)
         io.to(`user:${userId}`).emit('conversation.updated', {
            conversationId,
            unreadCount: result.newUnreadCount
         });
         
         // Notify others (read receipts)
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
module.exports = { attachSocket, onDisconnect, registerHandlers, userSockets: userSockets };