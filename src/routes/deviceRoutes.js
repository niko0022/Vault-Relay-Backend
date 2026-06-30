const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const passport = require('passport');
const auth = passport.authenticate('jwt', { session: false });

router.post('/register', auth, [
  body('deviceName').optional().isString().trim().isLength({ max: 64 })
], deviceController.registerDevice);
router.get('/', auth, deviceController.listDevices);
router.delete('/:deviceId', auth, [
  param('deviceId').isInt({ min: 1, max: 5 }).toInt()
], deviceController.unlinkDevice);
router.post('/recover/request', auth, deviceController.requestRecoveryCode);
router.post('/recover/verify', auth, [
  body('code').isString().trim().isLength({ min: 6, max: 6 })
], deviceController.verifyRecoveryCode);

module.exports = router;
