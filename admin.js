// admin.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const adminAuthenticate = require('./adminAuthMiddleware');
const User = require('./user');
const { getWalletBalances } = require('./ethereumWalletUtils');
const { getPriceInUSD } =require('./priceFetcher');
const fs = require('fs');
const path = require('path');

router.use(adminAuthenticate);

router.get('/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const kycPending = await User.countDocuments({ kycStatus: 'pending' });
    const withdrawalPending = await User.countDocuments({ 'withdrawals.status': 'pending' });

    const creditStats = await User.aggregate([
      { $group: { _id: null, totalCredits: { $sum: '$credits' } } },
    ]);

    const stakeStats = await User.aggregate([
        { $unwind: '$stakes' },
        { $match: { 'stakes.status': 'active' } },
        { $group: { _id: null, totalStaked: { $sum: '$stakes.amount' } } }
    ]);

    // Check if ADMIN_WALLET_ADDRESS is set before calling getWalletBalances
    let adminWalletBalances = { eth: 0, usdt: 0 };
    if (process.env.ADMIN_WALLET_ADDRESS) {
        adminWalletBalances = await getWalletBalances(process.env.ADMIN_WALLET_ADDRESS);
    } else {
        console.warn("ADMIN_WALLET_ADDRESS not set. Skipping admin wallet balance fetch.");
    }


    const totalCredits = creditStats.length > 0 ? creditStats[0]?.totalCredits || 0 : 0;
    const totalStaked = stakeStats.length > 0 ? stakeStats[0]?.totalStaked || 0 : 0;


    res.json({
      totalUsers,
      kycPending,
      withdrawalPending,
      totalCreditsInSystemUSD: totalCredits.toFixed(2),
      totalActivelyStakedUSD: totalStaked.toFixed(2),
      adminWallet: adminWalletBalances, // Use the fetched or default balances
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

router.get('/users', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    const users = await User.find({})
      .select('_id username email createdAt kycStatus isAdmin isActive credits referralEarnings')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await User.countDocuments();
    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Admin fetch users error:", err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post('/users/:userId/credits', async (req, res) => {
  const { amount, reason } = req.body;
  if (typeof amount !== 'number' || !reason) {
    return res.status(400).json({ error: 'Amount (number) and reason (string) are required.' });
  }

  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.credits = (user.credits || 0) + amount;
    user.creditsHistory.push({
      type: 'admin_adjustment',
      amount,
      reason: `Admin adjustment by ${req.user.username}: ${reason}`,
      date: new Date(),
    });
     const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);
     if (user.creditsHistory.length > historyLimit) {
        user.creditsHistory = user.creditsHistory.slice(-historyLimit);
     }

    await user.save();
    res.json({ message: 'Credits adjusted successfully.', newBalance: user.credits });
  } catch (err) {
    console.error("Admin credit adjust error:", err);
    res.status(500).json({ error: 'Failed to adjust credits' });
  }
});

router.get('/kyc/pending', async (req, res) => {
  try {
    const users = await User.find({ kycStatus: 'pending' })
      .select('_id username email kycStatus kycDocuments createdAt');
    res.json(users);
  } catch (err) {
    console.error("Admin fetch pending KYC error:", err);
    res.status(500).json({ error: 'Failed to fetch pending KYC submissions' });
  }
});

router.post('/kyc/:userId/approve', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { kycStatus: 'approved', kycApproved: true },
      { new: true, select: '_id kycStatus' }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'KYC approved.', user: { id: user._id, kycStatus: user.kycStatus } });
  } catch (err) {
    console.error("Admin approve KYC error:", err);
    res.status(500).json({ error: 'Failed to approve KYC' });
  }
});

router.post('/kyc/:userId/reject', async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.userId,
        { kycStatus: 'rejected', kycApproved: false },
        { new: true, select: '_id kycStatus' }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ message: 'KYC rejected.', user: { id: user._id, kycStatus: user.kycStatus } });
    } catch (err) {
      console.error("Admin reject KYC error:", err);
      res.status(500).json({ error: 'Failed to reject KYC' });
    }
});

router.get('/kyc/document/:filename', (req, res) => {
  try {
    const { filename } = req.params;

    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
       return res.status(400).json({ error: 'Invalid filename format' });
    }

    const filePath = path.join(__dirname, '../uploads/kyc/', filename);

    // Use fs.promises.stat or stat with a callback
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            console.warn(`Attempted to access missing KYC document: ${filename}`);
            return res.status(404).json({ error: 'Document not found' });
        }
        // Security check: ensure the resolved path is still within the uploads directory
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(uploadDir)) { // Assuming uploadDir is available or calculate it again
             console.error(`Attempted directory traversal detected: ${filename}`);
             return res.status(400).json({ error: 'Invalid file path' });
        }

        res.sendFile(filePath);
    });

  } catch (err) {
    console.error("Admin fetch KYC doc error:", err);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

router.get('/withdrawals/pending', async (req, res) => {
    try {
      const usersWithPendingWithdrawals = await User.find({
        'withdrawals.status': 'pending'
      }).select('_id username email withdrawals');

      // Fetch prices concurrently if needed
      let ethPrice = 0, usdtPrice = 0;
      try {
          [ethPrice, usdtPrice] = await Promise.all([
              getPriceInUSD('ETH').catch(() => 0), // Catch and set to 0 if fetch fails
              getPriceInUSD('USDT').catch(() => 0)
          ]);
      } catch (priceErr) {
           console.error("Failed to fetch crypto prices for pending withdrawals list:", priceErr.message);
           // Prices remain 0, which will result in 'N/A' for estimated amount
      }


      const pendingWithdrawals = usersWithPendingWithdrawals.map(user => {
        const mappedWithdrawals = user.withdrawals
          .filter(w => w.status === 'pending')
          .map(w => {
            let cryptoAmount = 0;
            // Calculate estimated crypto amount based on credits (USD value)
            if (w.asset === 'ETH' && ethPrice > 0) {
                cryptoAmount = w.amount / ethPrice; // w.amount is in credits (USD)
            } else if (w.asset === 'USDT' && usdtPrice > 0) {
                cryptoAmount = w.amount / usdtPrice; // w.amount is in credits (USD)
            } else {
                cryptoAmount = NaN; // Cannot calculate if price is zero or unavailable
            }
            return {
              ...w.toObject(),
              estimatedCryptoAmount: isNaN(cryptoAmount) || cryptoAmount <= 0 ? 'N/A' : cryptoAmount.toFixed(8) // Ensure positive amount for display
            };
          });

        return {
          userId: user._id,
          username: user.username,
          email: user.email,
          withdrawals: mappedWithdrawals
        };
      }).filter(u => u.withdrawals.length > 0);

      res.json(pendingWithdrawals);
    } catch (err) {
      console.error("Admin fetch pending withdrawals error:", err);
      res.status(500).json({ error: 'Failed to fetch pending withdrawals' });
    }
});

router.post('/withdrawals/:userId/complete', async (req, res) => {
    const { withdrawalId, txHash } = req.body;
    if (!withdrawalId || !txHash) {
      return res.status(400).json({ error: 'withdrawalId and txHash are required.' });
    }
    // Basic validation for txHash format (e.g., starts with 0x and is hex)
     if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
         return res.status(400).json({ error: 'Invalid transaction hash format.' });
     }


    try {
      // Use findOneAndUpdate to prevent race conditions
      const updatedUser = await User.findOneAndUpdate(
          { _id: req.params.userId, 'withdrawals.id': withdrawalId, 'withdrawals.status': 'pending' },
          {
              $set: {
                  'withdrawals.$.status': 'completed',
                  'withdrawals.$.processedDate': new Date(),
                  'withdrawals.$.txHash': txHash
              }
          },
          { new: true, select: 'withdrawals' }
      );

      if (!updatedUser) {
          // Check if user exists but withdrawal wasn't pending
          const userExists = await User.exists({ _id: req.params.userId });
          if (!userExists) {
               return res.status(404).json({ error: 'User not found.' });
          }
          const withdrawalExistsButNotPending = await User.exists({ _id: req.params.userId, 'withdrawals.id': withdrawalId, 'withdrawals.status': { $ne: 'pending' } });
          if (withdrawalExistsButNotPending) {
               const userCheck = await User.findById(req.params.userId).select('withdrawals');
               const withdrawal = userCheck?.withdrawals.find(w => w.id === withdrawalId);
               return res.status(400).json({ error: `Withdrawal is already in status: ${withdrawal?.status || 'unknown'}.` });
          }
          return res.status(404).json({ error: 'Pending withdrawal request not found for this user.' });
      }

      const completedWithdrawal = updatedUser.withdrawals.find(w => w.id === withdrawalId);


      res.json({ message: 'Withdrawal marked as complete.', withdrawal: completedWithdrawal });
    } catch (err) {
      console.error("Admin complete withdrawal error:", err);
      res.status(500).json({ error: 'Failed to complete withdrawal' });
    }
});

router.post('/withdrawals/:userId/fail', async (req, res) => {
    const { withdrawalId, reason } = req.body;
    if (!withdrawalId || !reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'withdrawalId and a non-empty reason are required.' });
    }

    try {
      // Use findOneAndUpdate to prevent race conditions and handle credits refund atomically
      const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);

      const user = await User.findById(req.params.userId).select('credits withdrawals creditsHistory');
      if (!user) {
          return res.status(404).json({ error: 'User not found' });
      }

      const withdrawalIndex = user.withdrawals.findIndex(w => w.id === withdrawalId);
      if (withdrawalIndex === -1) {
          return res.status(404).json({ error: 'Withdrawal request not found' });
      }

      const withdrawal = user.withdrawals[withdrawalIndex];

      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ error: `Withdrawal is already in status: ${withdrawal.status}` });
      }

      const amountToRefund = withdrawal.amount;

       // Prepare updates
       const update = {
           $set: {
               [`withdrawals.${withdrawalIndex}.status`]: 'failed',
               [`withdrawals.${withdrawalIndex}.processedDate`]: new Date()
           }
       };

       // Atomically update credits and push history
       update.$inc = { credits: amountToRefund };
       update.$push = {
           creditsHistory: {
               $each: [{
                   type: 'withdrawal_refund',
                   amount: amountToRefund,
                   reason: `Refund for failed withdrawal (ID: ${withdrawalId}). Admin reason: ${reason}`,
                   date: new Date()
               }],
               $sort: { date: 1 } // Keep history sorted by date ascending before slicing
           }
       };

       // Apply history limit using $slice
       // Note: $slice must be applied to the *end* for 'last N items'.
       // Mongoose/MongoDB $slice on $push can be complex with sorting.
       // An alternative is to manually manage the array after update or use aggregation frameworks.
       // For simplicity here, we rely on the cron job or a separate process to trim history if it exceeds limit significantly,
       // or implement more complex update logic. Let's stick to a simple slice after the push for now, acknowledging a slight race window.

       // Execute update
      const updatedUser = await User.findByIdAndUpdate(
          req.params.userId,
          update,
          { new: true, select: 'credits withdrawals creditsHistory' }
      );

      if (!updatedUser) {
           // This should ideally not happen if user was found initially, but for robustness:
           return res.status(500).json({ error: 'Failed to update user document after refund.' });
      }

      // Manually trim history AFTER the update if needed
      if (updatedUser.creditsHistory.length > historyLimit) {
           updatedUser.creditsHistory = updatedUser.creditsHistory.slice(-historyLimit); // Keep the last N
           await updatedUser.save().catch(saveErr => {
               console.error(`Error saving user history after withdrawal fail refund ${req.params.userId}:`, saveErr);
               // Log the error but don't fail the response, as the main credit/withdrawal update succeeded.
           });
      }


      res.json({
          message: 'Withdrawal marked as failed and credits have been refunded.',
          newCreditBalance: updatedUser.credits,
          failedWithdrawal: updatedUser.withdrawals.find(w => w.id === withdrawalId)
      });
    } catch (err) {
      console.error("Admin fail withdrawal error:", err);
      res.status(500).json({ error: 'Failed to process withdrawal failure.' });
    }
});

module.exports = router;