// withdrawal.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authenticate = require('./authMiddleware');
const User = require('./user');
const { isValidEthereumAddress } = require('./ethereumWalletUtils');
const { notifyAdminOfError } = require('./errorNotifier');
const { getPriceInUSD } = require('./priceFetcher');

const MIN_WITHDRAWAL_AMOUNT = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT || '10.00');

router.get('/withdrawal/balance', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('credits');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const availableForWithdrawal = user.credits || 0;

    res.json({
      message: '✅ Balance fetched successfully',
      totalCredits: availableForWithdrawal,
      availableForWithdrawal: availableForWithdrawal,
      minWithdrawalAmount: MIN_WITHDRAWAL_AMOUNT
    });
  } catch (err) {
    console.error('Withdrawal balance error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error fetching balance' });
  }
});

router.post('/withdrawal/request', authenticate, async (req, res) => {
  const { withdrawalAddress, amount, asset } = req.body;

  const parsedAmount = parseFloat(amount);

  if (!withdrawalAddress || isNaN(parsedAmount) || !asset) {
      return res.status(400).json({ error: 'Withdrawal address, a valid numeric amount, and asset type (ETH/USDT) are required.' });
  }
  if (!['ETH', 'USDT'].includes(asset.toUpperCase())) {
      return res.status(400).json({ error: "Invalid asset type. Must be 'ETH' or 'USDT'." });
  }
  if (!isValidEthereumAddress(withdrawalAddress)) {
    return res.status(400).json({ error: 'Invalid Ethereum address format.' });
  }
  if (parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0.' });
  }
  if (parsedAmount < MIN_WITHDRAWAL_AMOUNT) {
     return res.status(400).json({ error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT} credits.` });
  }


  try {
    const user = await User.findById(req.userId).select('_id username credits withdrawals creditsHistory');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const availableForWithdrawal = user.credits || 0;

    if (parsedAmount > availableForWithdrawal) {
      return res.status(400).json({
        error: `Insufficient balance. Available for withdrawal: ${availableForWithdrawal} credits.`,
        availableBalance: availableForWithdrawal
      });
    }

    const withdrawalId = crypto.randomBytes(16).toString('hex');
    const newHistoryEntry = {
      type: 'withdrawal',
      amount: -parsedAmount,
      reason: `Withdrawal request for ${asset.toUpperCase()} of ${parsedAmount} credits to ${withdrawalAddress}`,
      date: new Date()
    };

    const updatedUser = await User.findByIdAndUpdate(req.userId, {
        $inc: { credits: -parsedAmount },
        $push: {
            withdrawals: {
                id: withdrawalId,
                amount: parsedAmount,
                asset: asset.toUpperCase(),
                withdrawalAddress,
                status: 'pending',
                requestDate: new Date(),
            },
            creditsHistory: newHistoryEntry
        }
    }, { new: true, select: '_id username credits' });


    if (!updatedUser) {
        console.error('Failed to update user for withdrawal request:', req.userId);
         return res.status(500).json({ error: 'Failed to process withdrawal request.' });
    }

    const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);
     const userWithHistory = await User.findById(req.userId).select('creditsHistory');
     if(userWithHistory && userWithHistory.creditsHistory.length > historyLimit) {
        userWithHistory.creditsHistory = userWithHistory.creditsHistory.slice(-historyLimit);
        await userWithHistory.save().catch(saveErr => {
            console.error(`Error saving withdrawal history limit for ${req.userId}:`, saveErr);
        });
     }


    try {
        const cryptoPrice = await getPriceInUSD(asset.toUpperCase());
        const cryptoAmount = cryptoPrice > 0 ? parsedAmount / cryptoPrice : NaN;

        await notifyAdminOfError(
            'New Withdrawal Request',
            new Error(`A new withdrawal request is pending manual admin processing.`),
            `User: ${updatedUser.username} (${updatedUser._id})\n` +
            `Amount: ${parsedAmount.toFixed(2)} Credits (USD)\n` +
            `Asset: ${asset.toUpperCase()}\n` +
            `Estimated Crypto Amount: ${isNaN(cryptoAmount) ? 'N/A' : cryptoAmount.toFixed(8)}\n` +
            `To Address: ${withdrawalAddress}\n` +
            `Request ID: ${withdrawalId}`
        );
    } catch (notifyErr) {
         console.error('Failed to send admin notification for withdrawal request:', notifyErr);
    }


    res.status(202).json({
      message: '✅ Withdrawal request received and is being processed. This may take up to 24 hours.',
      withdrawal: {
          id: withdrawalId,
          amount: parsedAmount,
          asset: asset.toUpperCase(),
          withdrawalAddress: withdrawalAddress,
          status: 'pending',
          requestDate: new Date(),
      },
      newCreditBalance: updatedUser.credits,
    });

  } catch (err) {
    console.error('Withdrawal request error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error processing withdrawal. Please contact support.' });
  }
});

router.get('/withdrawal/history', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('withdrawals');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const withdrawals = user.withdrawals || [];
    const sortedWithdrawals = withdrawals.sort((a, b) => new Date(b.requestDate) - new Date(a.requestDate));

    res.json({
      message: '✅ Withdrawal history fetched successfully',
      withdrawals: sortedWithdrawals,
    });
  } catch (err) {
    console.error('Withdrawal history error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error fetching withdrawal history' });
  }
});

module.exports = router;