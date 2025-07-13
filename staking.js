// staking.js
const express = require('express');
const router = express.Router();
const authenticate = require('./authMiddleware');
const User = require('./user');

const STAKING_PLANS = [
  { id: 'quick', name: 'Quick Stake', duration: 7, minCredits: 50, rewardPercent: 100 },
  { id: 'standard', name: 'Standard Stake', duration: 30, minCredits: 100, rewardPercent: 250 },
  { id: 'premium', name: 'Premium Stake', duration: 90, minCredits: 500, rewardPercent: 500 },
  { id: 'elite', name: 'Elite Stake', duration: 180, minCredits: 1000, rewardPercent: 1000 }
];

router.get('/staking/plans', (req, res) => {
  res.json({
    message: '✅ Staking plans fetched successfully',
    plans: STAKING_PLANS
  });
});

router.post('/staking/plan', authenticate, async (req, res) => {
  const { planId, amount } = req.body;

  const parsedAmount = parseFloat(amount);

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
       return res.status(400).json({ error: 'A valid staking amount is required.' });
  }


  try {
    const user = await User.findById(req.userId).select('_id credits stakes creditsHistory');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const plan = STAKING_PLANS.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'Invalid staking plan' });

    if (parsedAmount < plan.minCredits) {
      return res.status(400).json({ error: `Minimum ${plan.minCredits} credits required for this plan` });
    }

    const availableCredits = user.credits || 0;
    if (parsedAmount > availableCredits) {
      return res.status(400).json({
        error: `Insufficient credits. Available: ${availableCredits}`,
        availableBalance: availableCredits
      });
    }

    user.credits = availableCredits - parsedAmount;

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + plan.duration * 24 * 60 * 60 * 1000);
    const totalReward = parsedAmount * (plan.rewardPercent / 100);
    const dailyReward = totalReward / plan.duration;

    if (!user.stakes) user.stakes = [];
    user.stakes.push({
      planId: plan.id,
      planName: plan.name,
      amount: parsedAmount,
      reward: totalReward,
      duration: plan.duration,
      dailyReward,
      daysPaid: 0,
      lastRewardDate: startDate,
      startDate,
      endDate,
      status: 'active'
    });

    if (!user.creditsHistory) user.creditsHistory = [];
     user.creditsHistory.push({
      type: 'stake',
      amount: -parsedAmount,
      reason: `Staked in ${plan.name} plan (Amount: ${parsedAmount})`,
      date: new Date(),
    });

     const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);
     if (user.creditsHistory.length > historyLimit) {
        user.creditsHistory = user.creditsHistory.slice(-historyLimit);
     }


    await user.save();

    const newStake = user.stakes[user.stakes.length - 1];

    res.json({
      message: `✅ Successfully staked ${parsedAmount} credits in ${plan.name}. Your new balance is ${user.credits}`,
      stake: newStake,
      newCreditBalance: user.credits
    });
  } catch (err) {
    console.error('Staking error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error during staking' });
  }
});

router.get('/staking/status', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('credits stakes');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const sortedStakes = (user.stakes || []).sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

    res.json({
      message: '✅ Stake status fetched',
      credits: user.credits || 0,
      stakes: sortedStakes
    });
  } catch (err) {
    console.error('Status fetch error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;