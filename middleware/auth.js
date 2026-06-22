const jwt = require('jsonwebtoken');

/**
 * Protects a route by requiring a valid "Authorization: Bearer <token>"
 * header. On success, attaches { id } to req.user so downstream
 * controllers can scope every database query to the authenticated user.
 */
module.exports = function requireAuth(req, res, next) {
  const authHeader = req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Access denied. Missing or malformed auth token.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};
