const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const router = express.Router();


//register route
router.post(
  '/register',
  [
    // validation + light normalization
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),

    body('password')
      .isString()
      .withMessage('Password required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters')
      .matches(/(?=(?:.*\d){3,})(?=.*[A-Z]).*/)
      .withMessage('Password must contain at least one uppercase letter and at least 3 digits'),

    body('displayName')
      .isString()
      .trim()
      .isLength({ max: 64 })
      .withMessage('Display name too long'),

    body('username')
      .isAlphanumeric()
      .withMessage('Username may only contain letters and numbers')
      .isLength({ min: 3, max: 32 })
      .withMessage('Username must be minimum 3 and maximum 32 characters'),
  ],
  authController.register
);

// Login route
router.post(
  '/login',
    [
        body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
        body('password').isString().withMessage('Password required').isLength({ min: 6 }).withMessage('Password too short'),
    ],
    authController.login
);

// Token refresh route
router.post('/refresh', authController.refresh);

// Logout route
router.post('/logout', authController.logout);

module.exports = router;