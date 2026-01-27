const prisma = require('../db/prismaClient');

async function isBlocked(userAId, userBId) {
    if (!userAId || !userBId) throw new Error('userAId and userBId required');

    const block = await prisma.friendship.findFirst({
        where: {
            OR: [
                { requesterId: userAId, addresseeId: userBId, status: 'BLOCKED' },
                { requesterId: userBId, addresseeId: userAId, status: 'BLOCKED' },
            ],
        },
        select: { id: true }
    });

    return !!block;
}

exports.isBlocked = isBlocked;