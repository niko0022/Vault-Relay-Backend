const prisma = require('../db/prismaClient');

async function acceptFriendRequest({ friendshipId, userId }) {
  if (!friendshipId || !userId) throw new Error('friendshipId and userId required');

  // load the friendship and validate
  const fr = await prisma.friendship.findUnique({ where: { id: friendshipId } });
  if (!fr) throw new Error('Friend request not found');
  if (fr.addresseeId !== userId) throw new Error('Not authorized to accept this request');
  if (fr.status !== 'PENDING') throw new Error('Friend request is not pending');

  const requesterId = fr.requesterId;
  const addresseeId = fr.addresseeId;

  // Canonicalize order for conversation unique constraint (so A-B and B-A map to same pair)
  const [aId, bId] = [requesterId, addresseeId].sort();

  try {
    // Use an interactive transaction so update + find/create are atomic.
    const [updatedFriendship, conversation] = await prisma.$transaction(async (tx) => {
        
      const updated = await tx.friendship.update({
        where: { id: friendshipId },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });


      const existingConv = await tx.conversation.findUnique({
        where: {
          participantAId_participantBId: {
            participantAId: aId,
            participantBId: bId,
          },
        },
      });
      if (existingConv) {
        return [updated, existingConv];
      }

      // 3) create the conversation and participants
      const conv = await tx.conversation.create({
        data: {
          type: 'DIRECT',
          participantAId: aId,
          participantBId: bId,
        },
      });

      // create participants for each user (role defaults to MEMBER)
      await tx.participant.createMany({
        data: [
          { conversationId: conv.id, userId: requesterId },
          { conversationId: conv.id, userId: addresseeId },
        ],
      });

      return [updated, conv];
    });

    return { friendship: updatedFriendship, conversation };
  } catch (err) {
    // handle rare race: concurrent creation of the same conversation -> re-query and return
    if (err && (err.code === 'P2002' || err.code === '23505')) {
      // Try to find the conversation that another worker created concurrently.
      const existingConv = await prisma.conversation.findUnique({
        where: {
          participantAId_participantBId: {
            participantAId: aId,
            participantBId: bId,
          },
        },
      });

      // Ensure friendship is marked accepted (best-effort)
      const updatedFriendship = await prisma.friendship.update({
        where: { id: friendshipId },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      return { friendship: updatedFriendship, conversation: existingConv };
    }

    // rethrow other errors
    throw err;
  }
}

module.exports = { acceptFriendRequest };
