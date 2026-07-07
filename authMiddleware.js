/**
 * authMiddleware.js
 * Middleware to enforce JWT token authentication for API routes.
 * Decodes the Bearer token and assigns the verified user metadata to req.user.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'gateway_jwt_secret_token_default_key_12984';

/**
 * Express middleware to verify JWT.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  // Extract token from "Bearer <token>"
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Authorization token missing.' });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    
    // Assign user payload to the request object
    req.user = {
      id: verified.id,
      email: verified.email,
      role: verified.role
    };
    
    next();
  } catch (error) {
    console.warn('[Auth Middleware] Invalid token presented:', error.message);
    return res.status(403).json({ error: 'Access denied. Invalid or expired token.' });
  }
}

module.exports = {
  authenticateToken
};
