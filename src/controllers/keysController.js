const keyService = require('../services/keyService');

exports.uploadKeys = async (req, res, next) => {
  try {
    const userId = req.user.id;
    // Client sends: { registrationId, identityKey, signedPreKey, oneTimePreKeys: [...] }
    await keyService.uploadKeys(userId, req.body);
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