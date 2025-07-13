// authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('./user');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!process.env.JWT_SECRET) {
        console.error('FATAL: JWT_SECRET is not set. Cannot verify token.');
        return res.status(500).json({ error: 'Server configuration error.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('_id isActive'); // Only fetch necessary fields

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Forbidden: Account is deactivated' });
    }

    req.userId = decoded.userId;
    next();
  } catch (err) {
    // Log specific JWT errors for better debugging
     if (err.name === 'TokenExpiredError') {
         console.warn('User JWT Expired:', err.message);
         return res.status(403).json({ error: 'Authentication token expired' });
     }
     if (err.name === 'JsonWebTokenError') {
          console.warn('Invalid User JWT:', err.message);
          return res.status(403).json({ error: 'Invalid authentication token' });
     }
    console.error("User auth error:", err.message); // Log other errors
    return res.status(403).json({ error: 'Authentication failed' });
  }
}

module.exports = authenticate;