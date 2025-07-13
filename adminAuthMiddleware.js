// adminAuthMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('./user');

async function adminAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication token missing' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (!user.isAdmin) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    req.userId = decoded.userId;
    req.user = user; // Attach the user document for easy access (e.g., username in admin adjustments)
    next();
  } catch (err) {
    // Log specific JWT errors for debugging
    if (err.name === 'TokenExpiredError') {
        console.warn('JWT Expired:', err.message);
        return res.status(403).json({ error: 'Authentication token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
         console.warn('Invalid JWT:', err.message);
         return res.status(403).json({ error: 'Invalid authentication token' });
    }
    console.error('Admin auth middleware error:', err); // Log other errors
    return res.status(403).json({ error: 'Authentication failed' });
  }
}

module.exports = adminAuthenticate;