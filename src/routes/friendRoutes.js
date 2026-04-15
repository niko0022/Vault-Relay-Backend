const route = require('express').Router();
const passport = require('passport');
const { param, body } = require('express-validator');
const friendController = require('../controllers/friendController');
const auth = passport.authenticate('jwt', { session: false });

// List friends (for current user)
route.get(
  '/',
  auth,
  friendController.listFriends
);

// List incoming pending friend requests
route.get(
  '/pending',
  auth,
  friendController.listPendingRequests
);

// List blocked users
route.get(
  '/blocked',
  auth,
  friendController.listBlockedUsers
);

// Create / send friend request (by friendCode in body)
route.post(
  '/',
  auth,
  [
    body('friendCode').isString().notEmpty().withMessage('friendCode is required'),
  ],
  friendController.addFriend
);

// Remove / unfriend (friendshipId in path)
route.delete(
  '/:friendshipId',
  auth,
  [
    param('friendshipId').isUUID().withMessage('friendshipId must be a valid UUID'),
  ],
  friendController.removeFriend
);

// Accept a friend request (friendshipId in path)
route.post(
  '/:friendshipId/accept',
  auth,
  [
    param('friendshipId').isUUID().withMessage('friendshipId must be a valid UUID'),
  ],
  friendController.acceptFriend
);

// Decline a friend request
route.post(
  '/:friendshipId/reject',
  auth,
  [
    param('friendshipId').isUUID().withMessage('friendshipId must be a valid UUID'),
  ],
  friendController.declineFriend
);

// Cancel an outgoing friend request (sender cancels their own request)
route.post(
  '/:friendshipId/cancel',
  auth,
  [
    param('friendshipId').isUUID().withMessage('friendshipId must be a valid UUID'),
  ],
  friendController.cancelFriendRequest
);

// Block a user (target user's id in path)
route.post(
  '/:userId/block',
  auth,
  [
    param('userId').isUUID().withMessage('userId must be a valid UUID'),
  ],
  friendController.blockFriend
);

// Unblock a user (target user's id in path)
route.post(
  '/:userId/unblock',
  auth,
  [
    param('userId').isUUID().withMessage('userId must be a valid UUID'),
  ],
  friendController.unblockFriend
);

module.exports = route;
