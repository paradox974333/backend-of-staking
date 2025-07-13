// user.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores']
  },
  email: {
    type: String,
    required: true,
    unique: true,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
    select: false
  },
  walletAddress: {
    type: String,
    required: true,
    unique: true
  },
  privateKey: {
    type: String,
    required: true,
    select: false
  },
  kycApproved: {
    type: Boolean,
    default: false
  },
  kycStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'not_submitted'],
    default: 'not_submitted',
    index: true
  },
  kycDocuments: [{
    path: String,
    filename: String,
    documentType: {
      type: String,
      enum: ['id_front', 'id_back', 'selfie', 'address_proof']
    },
    uploadDate: {
      type: Date,
      default: Date.now
    }
  }],
  registrationIp: {
    type: String,
    required: true
  },
  lastLoginIp: String,
  ipHistory: [{
    ip: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    action: {
      type: String,
      enum: ['registration', 'login', 'transaction', 'other']
    }
  }],
  credits: {
    type: Number,
    default: 0
  },
  deposits: [{
      txHash: String,
      asset: String,
      cryptoAmount: Number,
      usdValue: Number,
      blockNumber: Number,
      fromAddress: String,
      toAddress: String,
      status: {
          type: String,
          enum: ['unconfirmed', 'confirmed', 'credited', 'failed'],
          default: 'unconfirmed',
          index: true
      },
      detectedAt: {
          type: Date,
          default: Date.now
      },
      confirmedAt: Date,
      creditedAt: Date,
      error: String
  }],
  stakes: [{
    planId: String,
    planName: String,
    amount: Number,
    reward: Number,
    duration: Number,
    dailyReward: Number,
    daysPaid: Number,
    lastRewardDate: Date,
    startDate: Date,
    endDate: Date,
    status: {
      type: String,
      enum: ['active', 'completed'],
      default: 'active',
      index: true
    }
  }],
  creditsHistory: [{
    type: {
      type: String,
      enum: ['deposit', 'reward', 'referral', 'withdrawal', 'stake', 'admin_adjustment', 'withdrawal_refund']
    },
    amount: Number,
    reason: String,
    date: {
      type: Date,
      default: Date.now
    }
  }],
  withdrawals: [{
    id: String,
    asset: String,
    amount: Number,
    withdrawalAddress: String,
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
      index: true
    },
    requestDate: {
      type: Date,
      default: Date.now
    },
    processedDate: Date,
    txHash: String
  }],
  referralCode: {
    type: String,
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  referralEarnings: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isAdmin: {
    type: Boolean,
    default: false,
    index: true
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: String,
  emailVerificationExpires: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  lastLogin: Date,
  loginCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });
userSchema.index({ createdAt: 1 });
userSchema.index({ 'deposits.txHash': 1 }, { unique: true, sparse: true });

userSchema.index({ 'deposits.toAddress': 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
    const hashed = await bcrypt.hash(this.password, saltRounds);
    this.password = hashed;
    next();
  } catch (err) {
    console.error('Error hashing password:', err);
    next(err);
  }
});

userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.addIpToHistory = function (ip, action = 'other') {
  this.ipHistory.push({ ip, action, timestamp: new Date() });
  const historyLimit = parseInt(process.env.IP_HISTORY_LIMIT || '50', 10);
  if (this.ipHistory.length > historyLimit) {
    this.ipHistory.sort((a, b) => a.timestamp - b.timestamp);
    this.ipHistory = this.ipHistory.slice(-historyLimit);
  }
};

userSchema.statics.findByEmailOrUsername = function (identifier) {
  const query = {
    $or: [
      { email: identifier.toLowerCase() },
      { username: identifier }
    ]
  };
  return this.findOne(query);
};

userSchema.statics.findByWalletAddress = function (walletAddress) {
  return this.findOne({ walletAddress: walletAddress });
};

module.exports = mongoose.model('User', userSchema);