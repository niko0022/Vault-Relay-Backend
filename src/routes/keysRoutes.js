const express = require('express');
const router = express.Router();
const keysController = require('../controllers/keysController');
const passport = require('passport');
const auth = passport.authenticate('jwt', { session: false });

router.post('/', auth, keysController.uploadKeys);
router.get('/:userId', auth, keysController.getPreKeyBundle);

module.exports = router;