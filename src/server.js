require('dotenv').config();
const http = require('http');
const app = require('./app');
const prisma = require('./db/prismaClient'); 
const PORT = Number(process.env.PORT) || 4000;
const SHUTDOWN_TIMEOUT = Number(process.env.SHUTDOWN_TIMEOUT_MS); // ms
const {initializeSocketServer} = require('./socket');
const server = http.createServer(app);
const io = initializeSocketServer(server);
app.set('io', io);

// track open connections so we can destroy them if hang during shutdown
const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received. Starting graceful shutdown...`);

  // stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server has stopped accepting new connections.');
    }
  });

  // close socket.io if exists
  try {
    if (typeof io !== 'undefined' && io && io.close) {
      await io.close();
      console.log('Socket.IO closed.');
    }
  } catch (err) {
    console.error('Error closing Socket.IO:', err);
  }

  // disconnect prisma
  try {
    await prisma.$disconnect();
    console.log('Prisma disconnected.');
  } catch (err) {
    console.error('Error disconnecting Prisma:', err);
  }

  // destroy any remaining connections after a short delay
  setTimeout(() => {
    if (connections.size > 0) {
      console.warn(`Forcibly destroying ${connections.size} connection(s).`);
      connections.forEach((socket) => socket.destroy());
    }
  }, 100).unref();

  // force exit after SHUTDOWN_TIMEOUT
  setTimeout(() => {
    console.warn('Forcing process exit after shutdown timeout');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT).unref();
}

// handle signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// handle unexpected errors — attempt graceful shutdown
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  shutdown('uncaughtException');
});

// start server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
