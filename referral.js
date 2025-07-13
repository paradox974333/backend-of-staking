// referral.js
const express = require('express');
const router = express.Router();
const authenticate = require('./authMiddleware');
const User = require('./user');
const crypto = require('crypto');

async function generateUniqueReferralCode() {
  let referralCode;
  let isUnique = false;
  const maxRetries = 10;
  let attempts = 0;

  while (!isUnique && attempts < maxRetries) {
    referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const existingUser = await User.findOne({ referralCode }).select('_id');
    if (!existingUser) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
      console.error('Failed to generate unique referral code after multiple attempts.');
      throw new Error('Could not generate a unique referral code.');
  }

  return referralCode;
}

router.get('/referral/code', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id referralCode referralEarnings');
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.referralCode) {
       try {
            const newReferralCode = await generateUniqueReferralCode();
            user.referralCode = newReferralCode;
            await user.save();
       } catch (codeGenError) {
            console.error('Error generating referral code for user', req.userId, ':', codeGenError);
            return res.status(500).json({ error: 'Failed to generate referral code.' });
       }
    }

    res.json({
      message: '✅ Referral code retrieved successfully',
      referralCode: user.referralCode,
      referralEarnings: user.referralEarnings || 0
    });
  } catch (err) {
    console.error('Referral code endpoint error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/referral/stats', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id referralCode referralEarnings');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [totalReferrals, recentReferrals] = await Promise.all([
        User.countDocuments({ referredBy: user._id }),
        User.find({ referredBy: user._id })
          .select('username createdAt')
          .sort({ createdAt: -1 })
          .limit(10)
    ]);

    res.json({
      message: '✅ Referral stats fetched successfully',
      referralCode: user.referralCode,
      totalReferrals,
      totalEarnings: user.referralEarnings || 0,
      recentReferrals
    });
  } catch (err) {
    console.error('Referral stats endpoint error for user', req.userId, ':', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function processReferralReward(userId, stakeAmount) {
  try {
    const user = await User.findById(userId).select('_id username referredBy');
    if (!user || !user.referredBy) {
        return;
    }

    const referrer = await User.findById(user.referredBy).select('_id username credits referralEarnings creditsHistory');
    if (!referrer) {
        console.warn(`Referrer ${user.referredBy} not found for user ${userId}. Cannot process referral reward.`);
        return;
    }

    const referralRate = parseFloat(process.env.REFERRAL_RATE || '0.1');
    const rewardAmount = stakeAmount * referralRate;

    if (rewardAmount <= 0) {
       return;
    }

    const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);
    const newHistoryEntry = {
       type: 'referral',
       amount: rewardAmount,
       reason: `Referral bonus from ${user.username}'s completed stake (Stake Amount: ${stakeAmount})`,
       date: new Date()
    };


    const updateResult = await User.findByIdAndUpdate(
        referrer._id,
        {
            $inc: {
                credits: rewardAmount,
                referralEarnings: rewardAmount
            },
            $push: {
                creditsHistory: newHistoryEntry
            }
        },
        { new: true, select: '_id username credits referralEarnings' }
    );

    if (!updateResult) {
         console.error(`Failed to find and update referrer ${referrer._id} for reward.`);
         await notifyAdminOfError('Referral Reward Failed: Referrer Not Found', null, `Attempted to give referral reward to user ID ${referrer._id} but document not found during update.`).catch(console.error);
         return;
    }

    console.log(`💰 Referral reward: ${rewardAmount.toFixed(2)} credits added to ${updateResult.username} (${updateResult._id}) from user ${user.username} (${user._id})'s stake completion.`);

     const referrerAfterUpdate = await User.findById(referrer._id).select('creditsHistory');
     if(referrerAfterUpdate && referrerAfterUpdate.creditsHistory.length > historyLimit) {
        referrerAfterUpdate.creditsHistory = referrerAfterUpdate.creditsHistory.slice(-historyLimit);
        await referrerAfterUpdate.save().catch(saveErr => {
            console.error(`Error saving referrer history limit for ${referrer._id}:`, saveErr);
        });
     }


  } catch (err) {
    console.error(`❌ Referral reward processing error for user ${userId} (stake amount ${stakeAmount}):`, err);
    await notifyAdminOfError('Referral Reward Processing Failed', err, `User: ${userId}, Stake Amount: ${stakeAmount}`).catch(console.error);
  }
}

module.exports = {
  router,
  processReferralReward
};