const cron = require('node-cron');
const prisma = require('../db/prismaClient');

async function cleanupReadMessages() {
    console.log('Starting encrypted message cleanup sweep...');
    try {
        // Fetch all E2EE messages and their receipt counts vs expected participant counts
        const messages = await prisma.message.findMany({
            where: {
                contentType: {
                    in: ['SIGNAL_ENCRYPTED', 'SIGNAL_KEY_DISTRIBUTION']
                }
            },
            select: {
                id: true,
                _count: {
                    select: { receipts: true }
                },
                conversation: {
                    select: {
                        _count: { select: { participants: true } }
                    }
                }
            }
        });

        const toDeleteIds = [];

        for (const msg of messages) {
            // Expected recipients is total participants minus 1 (the sender itself doesn't issue a receipt to itself)
            const expectedReceipts = Math.max(0, msg.conversation._count.participants - 1);

            // If the number of read receipts is >= expected, everybody has read it
            if (msg._count.receipts >= expectedReceipts) {
                toDeleteIds.push(msg.id);
            }
        }

        if (toDeleteIds.length > 0) {
            const result = await prisma.message.deleteMany({
                where: {
                    id: { in: toDeleteIds }
                }
            });
            console.log(`[Cleanup] Sweep complete: Deleted ${result.count} fully-read encrypted messages.`);
        } else {
            console.log('[Cleanup] Sweep complete: No fully-read encrypted messages found.');
        }

    } catch (error) {
        console.error('[Cleanup] Error during message cleanup sweep:', error);
    }
}

function initializeCronJobs() {
    // Run every 2 hours for testing purposes
    cron.schedule('0 */2 * * *', () => {
        cleanupReadMessages();
    });
    console.log('Cron jobs initialized: Message Cleanup scheduled (Runs every 2 hours).');
}

module.exports = {
    initializeCronJobs,
};
