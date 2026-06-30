const prisma = require('../db/prismaClient');

async function uploadKeys(userId, deviceId, { registrationId, identityKey, signedPreKey, kyberPreKey, oneTimePreKeys }) {
  return prisma.$transaction(async (tx) => {
    const device = await tx.device.findUnique({
      where: { userId_deviceId: { userId, deviceId: parseInt(deviceId) } }
    });

    if (!device) {
      throw new Error(`Device ${deviceId} not registered for user ${userId}`);
    }

    const deviceDbId = device.id;

    if (identityKey) {
      const existingIdentity = await tx.identityKey.findUnique({ where: { deviceId: deviceDbId } });
      
      await tx.identityKey.upsert({
        where: { deviceId: deviceDbId },
        update: { publicKey: identityKey, registrationId },
        create: { deviceId: deviceDbId, publicKey: identityKey, registrationId }
      });

      // Clear obsolete OTKs if identity changed
      if (existingIdentity && (existingIdentity.publicKey !== identityKey || existingIdentity.registrationId !== registrationId)) {
        await tx.oneTimePreKey.deleteMany({ where: { deviceId: deviceDbId } });
      }
    }

    if (signedPreKey) {
      await tx.signedPreKey.upsert({
        where: { deviceId: deviceDbId },
        update: {
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey,
          signature: signedPreKey.signature
        },
        create: {
          deviceId: deviceDbId,
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey,
          signature: signedPreKey.signature
        }
      });
    }

    if (kyberPreKey) {
      await tx.kyberPreKey.upsert({
        where: { deviceId: deviceDbId },
        update: {
          keyId: kyberPreKey.keyId,
          publicKey: kyberPreKey.publicKey,
          signature: kyberPreKey.signature
        },
        create: {
          deviceId: deviceDbId,
          keyId: kyberPreKey.keyId,
          publicKey: kyberPreKey.publicKey,
          signature: kyberPreKey.signature
        }
      });
    }

    if (oneTimePreKeys && oneTimePreKeys.length > 0) {
      const existing = await tx.oneTimePreKey.findMany({
        where: {
          deviceId: deviceDbId,
          keyId: { in: oneTimePreKeys.map(k => k.keyId) }
        },
        select: { keyId: true }
      });

      const existingIds = new Set(existing.map(e => e.keyId));
      const newKeys = oneTimePreKeys.filter(k => !existingIds.has(k.keyId));

      if (newKeys.length > 0) {
        await tx.oneTimePreKey.createMany({
          data: newKeys.map(k => ({
            deviceId: deviceDbId,
            keyId: k.keyId,
            publicKey: k.publicKey
          }))
        });
      }
    }
  });
}

async function getPreKeyBundle(targetUserId) {
  return prisma.$transaction(async (tx) => {
    const devices = await tx.device.findMany({
      where: { userId: targetUserId },
      include: {
        identityKey: true,
        signedPreKey: true,
        kyberPreKey: true
      }
    });

    const bundles = [];

    for (const dev of devices) {
      if (!dev.identityKey || !dev.signedPreKey || !dev.kyberPreKey) {
        continue;
      }

      // Consume one OTK per device
      const oneTimePreKey = await tx.oneTimePreKey.findFirst({
        where: { deviceId: dev.id },
        orderBy: { keyId: 'asc' }
      });

      if (oneTimePreKey) {
        await tx.oneTimePreKey.delete({ where: { id: oneTimePreKey.id } });
      }

      bundles.push({
        userId: targetUserId,
        deviceId: dev.deviceId,
        registrationId: dev.identityKey.registrationId,
        identityKey: dev.identityKey.publicKey,
        signedPreKey: {
          keyId: dev.signedPreKey.keyId,
          publicKey: dev.signedPreKey.publicKey,
          signature: dev.signedPreKey.signature
        },
        kyberPreKey: {
          keyId: dev.kyberPreKey.keyId,
          publicKey: dev.kyberPreKey.publicKey,
          signature: dev.kyberPreKey.signature
        },
        oneTimePreKey: oneTimePreKey ? {
          keyId: oneTimePreKey.keyId,
          publicKey: oneTimePreKey.publicKey
        } : null
      });
    }

    return bundles;
  });
}

async function getPreKeyBundles(targetUserIds) {
  return prisma.$transaction(async (tx) => {
    const devices = await tx.device.findMany({
      where: { userId: { in: targetUserIds } },
      include: {
        identityKey: true,
        signedPreKey: true,
        kyberPreKey: true
      }
    });

    const bundles = [];

    for (const dev of devices) {
      if (!dev.identityKey || !dev.signedPreKey || !dev.kyberPreKey) {
        continue;
      }

      const oneTimePreKey = await tx.oneTimePreKey.findFirst({
        where: { deviceId: dev.id },
        orderBy: { keyId: 'asc' }
      });

      if (oneTimePreKey) {
        await tx.oneTimePreKey.delete({ where: { id: oneTimePreKey.id } });
      }

      bundles.push({
        userId: dev.userId,
        deviceId: dev.deviceId,
        registrationId: dev.identityKey.registrationId,
        identityKey: dev.identityKey.publicKey,
        signedPreKey: {
          keyId: dev.signedPreKey.keyId,
          publicKey: dev.signedPreKey.publicKey,
          signature: dev.signedPreKey.signature
        },
        kyberPreKey: {
          keyId: dev.kyberPreKey.keyId,
          publicKey: dev.kyberPreKey.publicKey,
          signature: dev.kyberPreKey.signature
        },
        oneTimePreKey: oneTimePreKey ? {
          keyId: oneTimePreKey.keyId,
          publicKey: oneTimePreKey.publicKey
        } : null
      });
    }

    return bundles;
  });
}

async function getPreKeyCount(userId, deviceId) {
  const device = await prisma.device.findUnique({
    where: { userId_deviceId: { userId, deviceId: parseInt(deviceId) } },
    include: {
      identityKey: true
    }
  });

  if (!device) {
    return { count: 0, registrationId: null };
  }

  const count = await prisma.oneTimePreKey.count({
    where: { deviceId: device.id }
  });

  return {
    count,
    registrationId: device.identityKey?.registrationId || null
  };
}

module.exports = { uploadKeys, getPreKeyBundle, getPreKeyBundles, getPreKeyCount };