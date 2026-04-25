const prisma = require('../db/prismaClient');

async function uploadKeys(userId, { registrationId, identityKey, signedPreKey, kyberPreKey, oneTimePreKeys }) {
  return prisma.$transaction(async (tx) => {

    if (identityKey) {
      const existingIdentity = await tx.identityKey.findUnique({ where: { userId } });
      
      await tx.identityKey.upsert({
        where: { userId },
        update: { publicKey: identityKey, registrationId },
        create: { userId, publicKey: identityKey, registrationId }
      });

      // If the identity key or registration ID changed (meaning the user cleared their browser/re-installed),
      // their old OneTimePreKeys are mathematically useless and share the same keyIds (0-99). 
      // We MUST delete them, otherwise the new keys won't upload due to ID collisions.
      if (existingIdentity && (existingIdentity.publicKey !== identityKey || existingIdentity.registrationId !== registrationId)) {
        await tx.oneTimePreKey.deleteMany({ where: { userId } });
      }
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

async function getPreKeyBundles(targetUserIds) {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch all root keys for the requested users
    const identities = await tx.identityKey.findMany({ where: { userId: { in: targetUserIds } } });
    const signedPreKeys = await tx.signedPreKey.findMany({ where: { userId: { in: targetUserIds } } });
    const kyberPreKeys = await tx.kyberPreKey.findMany({ where: { userId: { in: targetUserIds } } });

    // Map them for O(1) lookup
    const idMap = new Map(identities.map(i => [i.userId, i]));
    const spkMap = new Map(signedPreKeys.map(s => [s.userId, s]));
    const kpkMap = new Map(kyberPreKeys.map(k => [k.userId, k]));

    // 2. Fetch the oldest OneTimePreKey for EACH user. 
    // Prisma does not have a "findFirst for each in array" so we fetch all and manually filter
    const allOneTimeKeys = await tx.oneTimePreKey.findMany({
      where: { userId: { in: targetUserIds } },
      orderBy: { keyId: 'asc' }
    });

    const otkMap = new Map();
    const toDeleteIds = [];
    
    // Grab only the first one encountered per user (since they're ordered ASC by keyId)
    for (const otk of allOneTimeKeys) {
      if (!otkMap.has(otk.userId)) {
        otkMap.set(otk.userId, otk);
        toDeleteIds.push(otk.id);
      }
    }

    if (toDeleteIds.length > 0) {
      await tx.oneTimePreKey.deleteMany({ where: { id: { in: toDeleteIds } } });
    }

    // 3. Assemble and return the array of bundles
    const validBundles = [];
    for (const userId of targetUserIds) {
      const identity = idMap.get(userId);
      const signedPreKey = spkMap.get(userId);
      const kyberPreKey = kpkMap.get(userId);

      // Only return a bundle if they have fully set up E2EE keys
      if (identity && signedPreKey && kyberPreKey) {
        const oneTimePreKey = otkMap.get(userId);
        validBundles.push({
          userId: userId,
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
        });
      }
    }

    return validBundles;
  });
}

async function getPreKeyCount(userId) {
  const [count, identity] = await prisma.$transaction([
    prisma.oneTimePreKey.count({ where: { userId } }),
    prisma.identityKey.findUnique({
      where: { userId },
      select: { registrationId: true }
    })
  ]);

  return {
    count,
    registrationId: identity?.registrationId || null
  };
}

module.exports = { uploadKeys, getPreKeyBundle, getPreKeyBundles, getPreKeyCount };