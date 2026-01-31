const express = require('express');
const passport = require('passport');
const { body, query } = require('express-validator');
const messagesController = require('../controllers/messagesController')
const router = express.Router();
const auth = passport.authenticate('jwt', { session: false });
const { param } = require('express-validator');


router.get(
  '/:conversationId/messages',
  auth,
  [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('cursor').optional().isString(),
  ],
  messagesController.getMessages
);


router.post(
  '/:conversationId/messages',
  auth,
  [
    param('conversationId').isUUID().withMessage('invalid conversation id'),

    body('content')
      .optional({ values: 'falsy' })
      .trim()
      .isLength({ max: 5000 }).withMessage('content too long (max 5000)')
      .escape(), 
    body('contentType')
      .optional()
      .isIn(['SIGNAL_ENCRYPTED', 'SIGNAL_KEY_DISTRIBUTION'])
      .withMessage('invalid content type'),
    body('attachmentUrl')
      .optional({ values: 'falsy' })
      .isURL().withMessage('attachmentUrl must be a valid URL'),
    body('content')
      .isBase64()
      .withMessage('Encrypted content must be Base64 encoded'),
    body().custom((value, { req }) => {
      if (!req.body.content && !req.body.attachmentUrl) {
        throw new Error("either content or attachmentUrl is required");
      }
      return true;
    }),
  ],
  messagesController.sendMessage
);

router.post('/:conversationId/read', auth, messagesController.markRead);

router.put(
  '/:conversationId/messages/:messageId',
  auth,
  [
    param('conversationId').isUUID().withMessage('invalid conversation id'),
    param('messageId').isUUID().withMessage('invalid message id'),
  ],
  messagesController.editMessage
);

router.delete(
  '/:conversationId/messages/:messageId',
  auth,
  [
    param('conversationId').isUUID().withMessage('invalid conversation id'),
    param('messageId').isUUID().withMessage('invalid message id'),
  ],
  messagesController.deleteMessage
);

module.exports = router;
