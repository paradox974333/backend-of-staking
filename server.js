// server.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const { notifyAdminOfError } = require('./errorNotifier');
dotenv.config();

const User = require('./user');
const { generateEthereumWallet } = require('./ethereumWalletUtils');
const { initializeCronJobs } = require('./cronJobs');
const { initializeDepositListener, shutdownDepositListener } = require('./depositListener');


const app = express();

app.use(helmet());
app.use(cors());
app.use(mongoSanitize());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});
app.use('/api/', apiLimiter);

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many registration attempts from this IP, please try again later.'
});


app.use(express.json({ limit: '1mb' }));

function getClientIp(req) {
   return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || '127.0.0.1';
}
// app.set('trust proxy', 1);

function validatePassword(password) {
  const minLength = 8;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  if (password.length < minLength || !hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
    return { valid: false, message: 'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and special characters.' };
  }
  return { valid: true };
}

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE || '100', 10),
    minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE || '10', 10),
})
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.error('Connection Error Details:', err);
    process.exit(1);
  });

mongoose.connection.on('connected', () => console.log('Mongoose default connection open'));
mongoose.connection.on('disconnected', () => console.log('Mongoose default connection disconnected'));
mongoose.connection.on('error', (err) => console.error('Mongoose default connection error:', err));

async function ensureIndexes() {
    try {
        await User.ensureIndexes();
        console.log('✅ MongoDB indexes ensured.');
    } catch (err) {
        console.error('❌ Failed to ensure MongoDB indexes:', err);
    }
}
mongoose.connection.once('open', ensureIndexes);


app.get('/', (req, res) => {
  res.send('🚀 Ethereum Staking API is live');
});

app.post('/register', registerLimiter, async (req, res) => {
  const { username, email, password, agreeToTerms, referralCode } = req.body;
  const clientIp = getClientIp(req);

  if (!username || !email || !password || !agreeToTerms) {
    return res.status(400).json({ error: 'Username, email, password, and terms agreement are required' });
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.toLowerCase().trim();
  const cleanReferralCode = referralCode ? referralCode.toUpperCase().trim() : null;

  try {
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message });
    }

    const existingUser = await User.findOne({ $or: [{ email: cleanEmail }, { username: cleanUsername }] }).select('_id');

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email or username already exists' });
    }

    let referrerId = null;
    if (cleanReferralCode) {
      const referrer = await User.findOne({ referralCode: cleanReferralCode }).select('_id');
      if (referrer) {
        referrerId = referrer._id;
      } else {
         console.warn(`Invalid referral code used during registration: ${cleanReferralCode}`);
      }
    }

    let wallet;
    try {
       wallet = await generateEthereumWallet();
    } catch (walletError) {
        console.error('❌ Failed to generate wallet during registration:', walletError);
        return res.status(500).json({ error: 'Failed to create wallet during registration. Please try again.' });
    }

    const user = new User({
      username: cleanUsername,
      email: cleanEmail,
      password,
      walletAddress: wallet.address,
      privateKey: wallet.encryptedPrivateKey,
      registrationIp: clientIp,
      lastLoginIp: clientIp,
      referredBy: referrerId,
      credits: 0,
      kycStatus: 'not_submitted',
      isAdmin: false,
      isActive: true,
      loginCount: 0,
      ipHistory: [],
      creditsHistory: [],
      deposits: [],
      stakes: [],
      withdrawals: [],
      kycDocuments: []
    });

    user.addIpToHistory(clientIp, 'registration');

    await user.save();

    res.status(201).json({
      message: '✅ Account created successfully!',
      user: { id: user._id, username: user.username, email: user.email }
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    if (error.name === 'ValidationError') {
         return res.status(400).json({ error: error.message });
    }
    if (error.code === 11000) {
         const field = Object.keys(error.keyPattern)[0];
         return res.status(400).json({ error: `${field} already exists.` });
    }
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  const clientIp = getClientIp(req);

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email/username and password are required' });
  }
  const cleanIdentifier = identifier.trim();

  try {
    const user = await User.findByEmailOrUsername(cleanIdentifier).select('+password lastLogin lastLoginIp loginCount ipHistory isActive isAdmin username');

    if (!user || !(await user.comparePassword(password))) {
      console.warn(`Failed login attempt for identifier: ${cleanIdentifier} from IP: ${clientIp}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    user.lastLogin = new Date();
    user.lastLoginIp = clientIp;
    user.loginCount = (user.loginCount || 0) + 1;
    user.addIpToHistory(clientIp, 'login');

    const ipHistoryLimit = parseInt(process.env.IP_HISTORY_LIMIT || '50', 10);
    if (user.ipHistory.length > ipHistoryLimit) {
        user.ipHistory.sort((a, b) => a.timestamp - b.timestamp);
        user.ipHistory = user.ipHistory.slice(-ipHistoryLimit);
    }

    await user.save();

    const jwt = require('jsonwebtoken');
    if (!process.env.JWT_SECRET) {
        console.error('❌ FATAL: JWT_SECRET is not set in .env');
        return res.status(500).json({ error: 'Server configuration error: JWT secret not set.' });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: '✅ Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

const profileRoutes = require('./profile');
const stakingRoutes = require('./staking');
const withdrawalRoutes = require('./withdrawal');
const { router: referralRoutes } = require('./referral');
const historyRoutes = require('./history.js');
const kycRoutes = require('./kyc.js');
const adminRoutes = require('./admin.js');

app.use('/api', require('./authMiddleware'));

app.use('/api', profileRoutes);
app.use('/api', stakingRoutes);
app.use('/api', withdrawalRoutes);
app.use('/api', referralRoutes);
app.use('/api', historyRoutes);
app.use('/api', kycRoutes);

app.use('/api/admin', adminRoutes);

app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error('🚨 Unhandled Error:', err);

  if (err.name === 'MulterError') {
      let message = 'File upload failed.';
      if (err.code === 'LIMIT_FILE_SIZE') {
          message = 'One or more uploaded files are too large.';
      } else if (err.code === 'LIMIT_FILE_COUNT') {
           message = 'Too many files uploaded.';
      } else if (err.code === 'LIMIT_FIELD_KEY') {
           message = 'Field name too long.';
      }
      return res.status(400).json({ error: message });
  }


  const statusCode = err.status || 500;
  const message = (statusCode === 500 && process.env.NODE_ENV === 'production')
    ? 'An unexpected error occurred. Please try again later.'
    : err.message;

  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
      console.error(`Production 500 Error on ${req.method} ${req.originalUrl}:`, err);
  }

  res.status(statusCode).json({
    error: message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
  });
});


const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);

  if (process.env.NODE_APP_INSTANCE === '0' || process.env.NODE_APP_INSTANCE === undefined) {
       console.log('Initializing background services...');
       initializeCronJobs();
       initializeDepositListener();
  } else {
       console.log(`Worker ${process.env.NODE_APP_INSTANCE} skipping background service initialization.`);
  }

});

const gracefulShutdown = async (signal) => {
    console.info(`${signal} signal received: closing HTTP server`);
    server.close(async () => {
        console.info('HTTP server closed');
        shutdownDepositListener();
        await mongoose.connection.close(false);
        console.info('MongoDB connection closed');
        process.exit(0);
    });

    setTimeout(() => {
        console.error('⚠️ Forcefully shutting down server after timeout.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught Exception:', err);
     await notifyAdminOfError('Uncaught Exception', err, 'Server crashed due to uncaught exception.');
    gracefulShutdown('UncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'Reason:', reason);
     await notifyAdminOfError('Unhandled Rejection', reason, 'An unhandled promise rejection occurred.');
});