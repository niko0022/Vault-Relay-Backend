const express = require('express');
const passportModule = require('passport');
const { body } = require('express-validator');
const usersController = require('../controllers/usersController');
const router = express.Router();

const auth = passportModule.authenticate('jwt', { session: false });

router.get('/me', auth, usersController.getMe);

router.patch(
  '/me',
  auth,
  [
    body('username')
      .optional()
      .isString()
      .trim()
      .matches(/^[a-zA-Z0-9_]{3,20}$/)
      .withMessage('Username must be 3-20 characters long and can only contain letters, numbers, and underscores.'),
    body('displayName').optional().isString().trim().isLength({ max: 50 }),
  ],
  usersController.updateProfile
);

router.post(
  '/me/avatar/upload-url',
  auth,
  [
    body('contentType').isString().notEmpty().withMessage('contentType required'),
    body('originalName').optional().isString().trim().isLength({ max: 255 }),
  ],
  usersController.getAvatarUploadUrl
);

// After client PUTs to S3, call this to finalize
router.post(
  '/me/avatar/complete',
  auth,
  [body('key').isString().notEmpty().withMessage('key required')],
  usersController.completeAvatarUpload
);

router.delete(
  '/me/avatar',
  auth,
  [param('userId').isUUID().withMessage('invalid userId')],
  usersController.deleteAvatar
);

router.delete(
  '/me',
  auth,
  [param('userId').isUUID().withMessage('invalid userId')],
  usersController.deleteAccount
);

module.exports = router;