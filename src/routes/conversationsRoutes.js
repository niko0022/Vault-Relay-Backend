const express = require('express');
const passport = require('passport');
const { body, query, param } = require('express-validator');
const groupController = require('../controllers/groupsController');
const convController = require('../controllers/conversationsController');

const router = express.Router();
const auth = passport.authenticate('jwt', { session: false });

router.post(
  '/',
  auth,
  [ body('participantId').isString().notEmpty().withMessage('participantId required') ],
  convController.getOrCreateConversation
);

router.get(
  '/',
  auth,
  [
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('cursor').optional().isString(),
  ],
  convController.listConversations
);

router.get('/:id', auth, convController.getConversation);

router.post(
  '/group',
  auth,
  [
    body('title').optional().isString().trim().isLength({ max:200}).withMessage('title exeeds max lenght of 200 characters').escape(),
    body('participantIds').isArray({min:1,}).withMessage('pariciopants must be an non empty aray'),
    body('participantIds.*').isUUID().withMessage('each participantId must be a valid UUID'),
    body('avatarUrl').optional().isString().isURL().withMessage('avatarUrl must be a valid URL')
  ],
  groupController.createGroup
);

router.post(
  '/:id/participants',
  auth,
  [
    param('id').isUUID().withMessage('converstaion id must be a valid UUID'),
    body('userId').exists().isUUID().withMessage('userId required and must be a valid UUID'),
  ],
  groupController.addParticipant
);

router.delete(
  '/:id/participants/:userId',
  auth,
  [
    param('id').exists().isUUID().withMessage('converstaion id must be a valid UUID'),
    param('userId').exists().isUUID().withMessage('userId must be a valid UUID'),
  ],
  groupController.removeParticipant
);

router.get(
  '/:id/participants',
  auth,
  [
    param('id').exists().isUUID().withMessage('converstaion id must be a valid UUID'),
  ],
  groupController.listParticipants
);

router.delete('/:id', auth, 
  [
   param('id').isUUID().withMessage('converstaion id must be a valid UUID'),
  ],
  convController.deleteConversation
);


module.exports = router;
