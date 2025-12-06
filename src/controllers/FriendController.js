const prisma = require('../prismaClient'); 
const {acceptFriendRequest} = require('../services/friendService');
const isBlocked = require('../services/blockService')

exports.addFriend = async (req, res, next) => {
   try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Unauthorized Authentication required'});
    }

    const userFriendCode = req.body.friendCode;
    if (!userFriendCode || typeof userFriendCode !== 'string') {
        return res.status(400).json({ message: 'Valid friendCode is required in request body' });
    }

    const friend = await prisma.user.findUnique({
        where : { friendcode: userFriendCode}
    });
    if (!friend) {
        return res.status(404).json({ message: 'User with prvided friendcode not found' });
    }

    if (friend.id === meId) {
        return res.status(400).json({ message: 'Cannot add yourself as a friend' });
    }

    const exsitingFriendship = await prisma.friendship.findFirst({
        where: {
            OR : [
                { requesterId: meId, addresseeId: friend.id },
                { requesterId: friend.id, addresseeId: meId }
            ]
        }
    });

    if (exsitingFriendship) {
        if (exsitingFriendship.status === 'ACCEPTED') {
            return res.status(409).json({ message: 'You are already friends with this user' });
        }

        if (exsitingFriendship.status === 'PENDING' && exsitingFriendship.addresseeId === meId) {
            const accepted = await acceptFriendRequest({ friendshipId: exsitingFriendship.id, userId: meId });
            return res.status(200).json({ message: 'Friend request accepted', friendship: accepted });
        }

        if (exsitingFriendship && exsitingFriendship.status === 'PENDING' && exsitingFriendship.requesterId === meId) {
            return res.status(409).json({ message: 'Friend request already sent to this user' });
        }

        return res.status(409).json({ message: `Cannot add friend: current status = ${exsitingFriendship.status}` })
    }

    try {
        const createdFriendship = await prisma.friendship.create({
            data: {
                requesterId: meId,
                addresseeId: friend.id,
                message: req.body.message || null,
                status: 'PENDING',
                createdAt: new Date()
            }
        });
   
      return res.status(201).json({ type: 'created', friendship: createdFriendship });
    } catch (err) {
      // Prisma unique constraint collision (someone might have created the same relationship concurrently)
      if (err && (err.code === 'P2002' || err.code === '23505')) {
        // re-check the relationship to determine final state
        const nowExisting = await prisma.friendship.findFirst({
          where: {
            OR: [
              { requesterId: meId, addresseeId: friend.id },
              { requesterId: friend.id, addresseeId: meId },
            ],
          },
        });
        if (nowExisting) {
          // handle the same logic as above for nowExisting
          if (nowExisting.status === 'ACCEPTED') return res.status(409).json({ message: 'Already friends' });
          if (nowExisting.status === 'PENDING' && nowExisting.addresseeId === meId) {
            const accepted = await prisma.friendship.update({
              where: { id: nowExisting.id },
              data: { status: 'ACCEPTED', acceptedAt: new Date() },
            });
            return res.status(200).json({ type: 'accepted', friendship: accepted });
          }
          return res.status(409).json({ message: 'Friend request already exists' });
        }
        // If still no existing row (very unlikely), return conflict
        return res.status(409).json({ message: 'Could not create friend request due to conflict' });
      }
      throw err; // bubble up other errors
    }
  } catch (err) {
    return next(err);
  }
};

exports.listFriends = async (req, res, next) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Unauthorized Authentication required'});
    }

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: meId },
          { addresseeId: meId },
        ],
      },
      orderBy: { acceptedAt: 'desc' },
      include: {
        requester: {
          select: {
            id: true,
            displayName: true,
            username: true,
            friendCode: true,
            avatarUrl: true,
          },
        },
        addressee: {
          select: {
            id: true,
            displayName: true,
            username: true,
            friendCode: true,
            avatarUrl: true,
          },
        },
      },
    });

    const friendsList = friendships.map((f) => {
      const otherUser = f.requesterId === meId ? f.addressee : f.requester;
      return {
        friendshipId: f.id,
        user: otherUser,
        since: f.acceptedAt ?? f.updatedAt ?? f.createdAt,
      };
    });

    return res.status(200).json({ count: friendsList.length, friends: friendsList });

  } catch (err) {
    return next (err);
  }
};

exports.acceptFriend = async (req, res, next) => {
  try {

    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const friendshipId = req.params.friendshipId;
    if (!friendshipId || typeof friendshipId !== 'string') {
      return res.status(400).json({ message: 'friendshipId is required in request params' });
    }

    const result = await acceptFriendRequest({ friendshipId, userId: meId });

    return res.status(200).json({
      message: 'Friend request accepted',
      ...result, 
    });
  } catch (err) {
    
    const msg = String(err?.message ?? '').toLowerCase();

    if (msg.includes('not found')) {
      return res.status(404).json({ message: err.message || 'Not found' });
    }
    if (msg.includes('not authorized') || msg.includes('not permitted')) {
      return res.status(403).json({ message: err.message || 'Forbidden' });
    }
    if (msg.includes('not pending') || msg.includes('already')) {
      return res.status(400).json({ message: err.message || 'Bad request' });
    }
    return next(err);
  }
};


exports.declineFriend = async (req, res, next) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Unauthorized Authentication required'});
    }

    const friendshipId = req.params.friendshipId;
    if (!friendshipId) {
        return res.status(400).json({ message:  'friendshipId is required in request body' });
    }

    const friendship = await prisma.friendship.findUnique({
      where: { id: friendshipId}
    })
    if (!friendship) {
      return res.status(404).json({ message: 'Friend request not found' });
    }

    if (friendship.addresseeId !== meId) {
      return res.status(403).json({message: 'Not authorized to decline this friend request you are not the addressee of this friend request' });
    }

    if (friendship.status !== 'PENDING') {
      return res.status(400).json({ message: 'Friendship request cannot be declined if it is not pending' });
    }

    const declined = await prisma.friendship.update ({
      where: {id: friendshipId},
      data: { status: 'DECLINED', updatedAt: new Date() }
    })

    return res.status(200).json({message: 'Friend request declined', friendship: declined });
  } catch (err) {
    return next(err)
  }
};

exports.cancelFriendRequest = async (req, res, next) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Unauthorized Authentication required'});
    }

    const friendshipId = req.params.friendshipId;
    if (!friendshipId) {
      return res.status(400).json({message: 'friendshipId is required in request body'});
    }

    const friendship = await prisma.friendship.findUnique({
      where: {id: friendshipId}
    })
    if(!friendship) {
      return res.status(404).json({message: 'friend request not found'});
    }

    if (friendship.requesterId !== meId) {
      return res.status(403).json({message: 'Not authorized to cancel this friend request you are not the requester of this friend request'});
    }

    if (friendship.status !== 'PENDING') {
      return res.status(400).json({message: 'Only pending friend requests can be cancelled'});
    }

    const cancelled = await prisma.friendship.update({
      where: {id: friendshipId},
      data: { status: 'CANCELLED', updatedAt: new Date() }
    })

    return res.status(200).json({message: 'Friend request cancelled', friendship: cancelled });
  } catch (err) {
    return next (err);
  }
};

exports.blockFriend = async (req, res, next) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Unauthorized Authentication required'});
    }

    const targetUser = req.params.userId;
    if (!targetUser) {
      return res.status(400).json({ message: 'target userId is required in request params'});
    }

    if (targetUser === meId) {
      return res.status(400).json({ message: 'Cannot block yourself'});
    }

    const target = await prisma.user.findUnique({
      where: { id: targetUser}
    })
    if (!target) {
      return res.status(404).json({ messsage: 'Target user not found'});
    }

    const friendship = await prisma.$transaction(async (tx) => {
      const existing = await tx.friendship.findFirst({
        where: {
          OR: [
            { requesterId: meId, addresseeId: targetUser },
            { requesterId: targetUser, addresseeId: meId },
          ],
        },
      });

      if (existing) {
        if (existing.status === 'BLOCKED') {
          return existing; // already blocked
        }
        // update existing relationship to BLOCKED
        return tx.friendship.update({
          where: { id: existing.id },
          data: { status: 'BLOCKED', updatedAt: new Date() },
        });
      };

      return tx.friendship.create({
        data: {
          requesterId: meId,
          addresseeId: targetUser,
          status: 'BLOCKED',
        },
      });
    });

    const blocked = await isBlocked(meId, targetUser);
    return res.status(200).json({
      message: 'User blocked successfully. Messaging between you and this user is now disabled.',
      friendship,
      blocked,
    });
  } catch (err) {
    return next (err)
  }
};

exports.unblockFriend = async (req, res, next) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const targetUser = req.params.userId;
    if (!targetUser || typeof targetUser !== 'string') {
      return res.status(400).json({ message: 'target userId is required in request params' });
    }
    
    if (targetUser === meId) {
      return res.status(400).json({ message: 'Cannot unblock yourself' });
    }
    
    const target = await prisma.user.findUnique({ where: { id: targetUser } });
    if (!target) {
      return res.status(404).json({ message: 'Target user not found' });
    }

    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: meId, addresseeId: targetUser, status: 'BLOCKED' }, 
          { requesterId: targetUser, addresseeId: meId, status: 'BLOCKED' }, 
        ],
      },
    });

    if (!friendship) {
      return res.status(404).json({ message: 'No blocked relationship found with the specified user' });
    }
    
    if (friendship.requesterId === targetUser && friendship.addresseeId === meId) {
      return res.status(403).json({ message: 'Cannot unblock: this user has blocked you. They must unblock you.' });
    }

    const unblockedFriendship = await prisma.friendship.update({
      where: { id: friendship.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), updatedAt: new Date() },
    });

    const blocked = await isBlocked(meId, targetUser);

    return res.status(200).json({
      message: 'User unblocked successfully.',
      friendship: unblockedFriendship,
      blocked,
    });
  } catch (err) {
    return next(err);
  }
};