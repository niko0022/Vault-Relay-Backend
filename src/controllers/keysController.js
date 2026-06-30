const keyService = require('../services/keyService');

exports.uploadKeys = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;
    if (!deviceId) {
      return res.status(400).json({ message: 'Device not registered' });
    }
    await keyService.uploadKeys(userId, deviceId, req.body);
    return res.json({ message: 'Keys uploaded successfully' });
  } catch (err) {
    next(err);
  }
};

exports.getPreKeyBundle = async (req, res, next) => {
  try {
    const { userId } = req.params; // The user we want to talk to
    const bundle = await keyService.getPreKeyBundle(userId);
    return res.json(bundle);
  } catch (err) {
    next(err);
  }
};

exports.getPreKeyCount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const deviceId = req.deviceId;
    if (!deviceId) {
      return res.status(400).json({ message: 'Device not registered' });
    }
    const status = await keyService.getPreKeyCount(userId, deviceId);
    return res.json(status);
  } catch (err) {
    next(err);
  }
};

exports.getPreKeyBundles = async (req, res, next) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) {
      return res.status(400).json({ message: 'userIds must be an array' });
    }
    const bundles = await keyService.getPreKeyBundles(userIds);
    return res.json({ bundles });
  } catch (err) {
    next(err);
  }
};