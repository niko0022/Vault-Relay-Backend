const prisma = require('../db/prismaClient');

async function uploadKeys(userId, { registrationId, identityKey, signedPreKey, kyberPreKey, oneTimePreKeys }) {
  return prisma.$transaction(async (tx) => {

    if (identityKey) {
      await tx.identityKey.upsert({
        where: { userId },
        update: { publicKey: identityKey, registrationId },
        create: { userId, publicKey: identityKey, registrationId }
      });
    }

    if (signedPreKey) {
      await tx.signedPreKey.upsert({
        where: { userId },
        update: {
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey,
          signature: signedPreKey.signature
        },
        create: {
          userId,
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey,
          signature: signedPreKey.signature
        }
      });
    }

    if (kyberPreKey) {
      await tx.kyberPreKey.upsert({
        where: { userId },
        update: {
          keyId: kyberPreKey.keyId,
          publicKey: kyberPreKey.publicKey,
          signature: kyberPreKey.signature
        },
        create: {
          userId,
          keyId: kyberPreKey.keyId,
          publicKey: kyberPreKey.publicKey,
          signature: kyberPreKey.signature
        }
      });
    }

    if (oneTimePreKeys && oneTimePreKeys.length > 0) {
      const existing = await tx.oneTimePreKey.findMany({
        where: {
          userId,
          keyId: { in: oneTimePreKeys.map(k => k.keyId) }
        },
        select: { keyId: true }
      });

      const existingIds = new Set(existing.map(e => e.keyId));
      const newKeys = oneTimePreKeys.filter(k => !existingIds.has(k.keyId));

      if (newKeys.length > 0) {
        await tx.oneTimePreKey.createMany({
          data: newKeys.map(k => ({
            userId,
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
    const identity = await tx.identityKey.findUnique({ where: { userId: targetUserId } });
    const signedPreKey = await tx.signedPreKey.findUnique({ where: { userId: targetUserId } });
    const kyberPreKey = await tx.kyberPreKey.findUnique({ where: { userId: targetUserId } });

    if (!identity || !signedPreKey || !kyberPreKey) {
      throw new Error('User has not set up E2EE keys yet.');
    }

    const oneTimePreKey = await tx.oneTimePreKey.findFirst({
      where: { userId: targetUserId },
      orderBy: { keyId: 'asc' }
    });

    if (oneTimePreKey) {
      await tx.oneTimePreKey.delete({ where: { id: oneTimePreKey.id } });
    }

    return {
      userId: targetUserId,
      registrationId: identity.registrationId,
      identityKey: identity.publicKey,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature
      },
      kyberPreKey: {
        keyId: kyberPreKey.keyId,
        publicKey: kyberPreKey.publicKey,
        signature: kyberPreKey.signature
      },
      oneTimePreKey: oneTimePreKey ? {
        keyId: oneTimePreKey.keyId,
        publicKey: oneTimePreKey.publicKey
      } : null
    };
  });
}

async function getPreKeyCount(userId) {
  const count = await prisma.oneTimePreKey.count({
    where: { userId }
  });
  return count;
}

module.exports = { uploadKeys, getPreKeyBundle, getPreKeyCount };