require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const prisma = require('./db/prismaClient');
const {initializePassport} = require('./middleware/passport');
const passport = initializePassport(require('passport'));
const app = express();

// Basic middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());


// Attach prisma client to request for convenience in handlers
app.use((req, res, next) => {
    req.prisma = prisma;
    next();
});

// Health endpoint
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// auth route 
app.use('/auth', require('./routes/authRoutes'));
app.use('/users', require('./routes/usersRoutes'));
app.use('/conversations', require('./routes/conversationsRoutes'));
app.use('/conversations', require('./routes/messagesRoutes'));
app.use('/friends', require('./routes/friendRoutes'));

// Global error handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

module.exports = app;