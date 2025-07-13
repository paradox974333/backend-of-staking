// history.js
const express = require('express');
const router = express.Router();
const authenticate = require('./authMiddleware');
const User = require('./user');

// GET /api/history/history - Get logged-in user's credit transaction history
router.get('/history/history', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('creditsHistory');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sortedHistory = user.creditsHistory.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      message: '✅ Credit history fetched successfully',
      history: sortedHistory,
    });
  } catch (err) {
    console.error('Error fetching credit history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;