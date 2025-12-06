const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const createAdapter = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const SocketService = require('./services/socketService');

let io;

function initializeSocketServer(httpServer) {
    if (io) {
        return io;
    }

    io = new Server(httpServer, {
        path: '/socket.io',
        cors: {
            origin: process.env.CORS_ORIGIN,
            credentials: true 
        },
        maxHttpBufferSize: 1e6,
    });

    if (process.env.REDIS_URL) {
        const pubClient = new Redis(process.env.REDIS_URL);
        const subClient = pubClient.duplicate();
        pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
        subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));
        io.adapter(createAdapter(pubClient, subClient));
        console.log('Socket.IO using Redis adapter');
    }

    io.use(async (socket, next) => {
        try {
            const { token: tokenFromAuth } = socket.handshake.auth || {};
            let token = tokenFromAuth;

            if (!token && socket.handshake.headers && socket.handshake.headers.cookie) {
                const cookies = cookie.parse(socket.handshake.headers.cookie || '');
                token = cookies['accessToken']; 
            }

            if (!token) {
                return next(new Error('Authentication error: token missing'));
            }

            const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
            if (!ACCESS_SECRET) throw new Error('Server misconfigured: missing JWT_ACCESS_SECRET');

            const payload = jwt.verify(token, ACCESS_SECRET);
            
            socket.user = { id: payload.sub, ...payload }; 


            await SocketService.attachSocket(io, socket);

            return next();
        } catch (err) {
            console.error("Socket Auth Error:", err.message);
            return next(new Error('Authentication error: Unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`User connected: ${socket.user.id}`);

        SocketService.registerHandlers(io, socket);

        socket.on('disconnect', (reason) => {
            SocketService.onDisconnect(io, socket, reason).catch((err) => {
                console.error('Error in onDisconnect:', err);
            });
        });
    });

    return io;
}

module.exports = { initializeSocketServer, get io() { return io; } };