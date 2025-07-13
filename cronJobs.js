// cronJobs.js
const cron = require('node-cron');
const User = require('./user');
const { processReferralReward } = require('./referral');
const { notifyAdminOfError } = require('./errorNotifier');
const { processConfirmedDeposit } = require('./depositListener');


let isDailyRewardsJobRunning = false;


async function distributeDailyRewards() {
  if (isDailyRewardsJobRunning) {
    console.log('🕐 Daily rewards job is already running. Skipping this run.');
    return;
  }
  isDailyRewardsJobRunning = true;
  console.log('🕐 Running daily stake rewards distribution...');

  const now = new Date();
  let processedCount = 0;
  const cursorConcurrency = parseInt(process.env.CRON_REWARDS_CONCURRENCY || '5', 10);
  const historyLimit = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);


  try {
    const cursor = User.find({ 'stakes.status': 'active', isActive: true })
      .select('_id username credits creditsHistory stakes')
      .cursor();
    console.log('Starting cursor iteration for daily rewards...');

    await cursor.eachAsync(async (user) => {
      processedCount++;
      let userUpdated = false;

      const activeStakes = user.stakes.filter(stake => stake.status === 'active');

      for (const stake of activeStakes) {
        const lastRewardDate = new Date(stake.lastRewardDate);
        const startOfLastRewardDayUTC = new Date(Date.UTC(lastRewardDate.getUTCFullYear(), lastRewardDate.getUTCMonth(), lastRewardDate.getUTCDate()));
        const startOfTodayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        const daysSinceLastReward = Math.floor((startOfTodayUTC - startOfLastRewardDayUTC) / (24 * 60 * 60 * 1000));

        if (daysSinceLastReward >= 1) {
          const daysRemaining = stake.duration - stake.daysPaid;
          const daysToPay = Math.min(daysSinceLastReward, daysRemaining);

          if (daysToPay > 0) {
            const rewardToCredit = stake.dailyReward * daysToPay;
            user.credits = (user.credits || 0) + rewardToCredit;
            user.creditsHistory.push({
              type: 'reward',
              amount: rewardToCredit,
              reason: `Daily staking reward for ${stake.planName}`,
              date: new Date()
            });

            stake.daysPaid += daysToPay;
            stake.lastRewardDate = new Date(startOfLastRewardDayUTC.getTime() + daysToPay * 24 * 60 * 60 * 1000);
            userUpdated = true;
          }

          if (stake.daysPaid >= stake.duration) {
            stake.status = 'completed';
            const principalToReturn = stake.amount;
            user.credits = (user.credits || 0) + principalToReturn;
            user.creditsHistory.push({
                type: 'stake',
                amount: principalToReturn,
                reason: `Completed stake principal returned for ${stake.planName}`,
                date: new Date()
            });
            console.log(`✅ Stake completed for user ${user.username} (${user._id}): ${stake.planName}. Returned principal of ${principalToReturn} credits.`);

            setImmediate(() => {
              processReferralReward(user._id, stake.amount).catch(err => {
                console.error(`❌ Failed to process referral reward for user ${user._id}'s stake completion:`, err);
                notifyAdminOfError('Referral Reward Processing Error', err, `User ID: ${user._id}, Stake Amount: ${stake.amount}`).catch(console.error);
              });
            });

            userUpdated = true;
          }
        }
      }

       if (user.creditsHistory.length > historyLimit) {
          user.creditsHistory = user.creditsHistory.slice(-historyLimit);
       }

      if (userUpdated) {
        try {
          await user.save();
        } catch (saveErr) {
          console.error(`❌ Error saving user ${user._id} during daily rewards:`, saveErr);
          await notifyAdminOfError('Daily Rewards Save Error', saveErr, `Failed to save user ${user._id} during rewards distribution.`);
        }
      }

       if (processedCount % 1000 === 0) {
           console.log(`Processed ${processedCount} users for daily rewards...`);
       }

    }, { concurrency: cursorConcurrency });

    console.log(`✅ Daily stake rewards distribution completed. Processed ${processedCount} users.`);

  } catch (error) {
    console.error('❌ Critical error in daily rewards distribution:', error);
    await notifyAdminOfError('Daily Rewards Cron Job Failed', error);
  } finally {
    isDailyRewardsJobRunning = false;
  }
}

async function depositCatchUpJob() {
    console.log('🔍 Running deposit catch-up job...');

    try {
        const depositsToProcess = await User.aggregate([
             { $match: { 'deposits.status': 'confirmed' } },
             { $unwind: '$deposits' },
             { $match: { 'deposits.status': 'confirmed' } },
             { $project: {
                 _id: 0,
                 userId: '$_id',
                 txHash: '$deposits.txHash'
             }}
         ]);

        if (depositsToProcess.length === 0) {
            console.log('No confirmed deposits needing catch-up processing.');
            return;
        }

        console.log(`Found ${depositsToProcess.length} confirmed deposits needing catch-up...`);

        const processingPromises = depositsToProcess.map(deposit =>
            processConfirmedDeposit(deposit.txHash)
        );

        await Promise.allSettled(processingPromises);

        console.log('✅ Deposit catch-up job completed.');

    } catch (error) {
        console.error('❌ Critical error in deposit catch-up job:', error);
        await notifyAdminOfError('Deposit Catch-Up Cron Job Failed', error);
    }
}

function initializeCronJobs() {
  console.log('📅 Initializing cron jobs...');

  cron.schedule('0 0 * * *', () => {
      console.log('🕐 Triggering daily stake rewards distribution...');
    distributeDailyRewards().catch(err => console.error('Error running daily rewards job:', err));
  });

  cron.schedule('0 * * * *', () => {
      console.log('🔍 Triggering deposit catch-up job...');
    depositCatchUpJob().catch(err => console.error('Error running deposit catch-up job:', err));
  });

  console.log('📅 Cron jobs initialized (Daily Rewards, Deposit Catch-up).');
  console.log('✨ Deposit detection and confirmation monitoring handled by depositListener.');
}


module.exports = {
    initializeCronJobs,
};