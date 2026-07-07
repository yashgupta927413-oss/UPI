/**
 * authRouter.js
 * Express router handling user registration, login, and profile fetching.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('./authMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || 'gateway_jwt_secret_token_default_key_12984';

/**
 * Creates the auth Express router.
 * @param {import('pg').Pool} dbPool PostgreSQL connection pool wrapper.
 * @returns {express.Router} Configured auth router.
 */
function createAuthRouter(dbPool) {
  const router = express.Router();

  const getDb = () => {
    if (dbPool && typeof dbPool === 'object' && 'pool' in dbPool) {
      if (!dbPool.pool) {
        throw new Error('Database pool not initialized. Please configure database credentials in the Database Setup Wizard.');
      }
      return dbPool.pool;
    }
    if (!dbPool) throw new Error('Database pool not initialized.');
    return dbPool;
  };

  // ==========================================
  // POST /api/auth/register
  // Registers a new merchant user
  // ==========================================
  router.post('/register', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    try {
      // Hash password using bcrypt
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      const apiKey = 'upi_live_' + require('crypto').randomBytes(24).toString('hex');
      const query = `
        INSERT INTO users (email, password_hash, api_key, role)
        VALUES ($1, $2, $3, 'merchant')
        RETURNING id, email, role, created_at;
      `;
      const dbRes = await getDb().query(query, [email.trim().toLowerCase(), passwordHash, apiKey]);
      const user = dbRes.rows[0];

      // Generate JWT
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

      return res.status(201).json({
        message: 'Registration successful!',
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      });
    } catch (error) {
      if (error.code === '23505') { // Unique constraint violation
        return res.status(409).json({ error: 'Email is already registered.' });
      }
      console.error('[Auth Router] Registration error:', error);
      return res.status(500).json({ error: 'Database error during registration.' });
    }
  });

  // ==========================================
  // POST /api/auth/login
  // Authenticates a merchant user and returns a session JWT
  // ==========================================
  router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
      const query = `SELECT * FROM users WHERE email = $1`;
      const dbRes = await getDb().query(query, [email.trim().toLowerCase()]);
      
      if (dbRes.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const user = dbRes.rows[0];

      // Compare password hashes
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Generate JWT
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

      return res.status(200).json({
        message: 'Login successful!',
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      });
    } catch (error) {
      console.error('[Auth Router] Login error:', error);
      return res.status(500).json({ error: 'Database query failed during login.' });
    }
  });

  // ==========================================
  // GET /api/auth/me
  // Fetches current authenticated user details
  // ==========================================
  router.get('/me', authenticateToken, async (req, res) => {
    try {
      const query = `
        SELECT id, email, shopify_store, gateway_url, role, created_at 
        FROM users 
        WHERE id = $1
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      
      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'User profile not found.' });
      }

      return res.status(200).json(dbRes.rows[0]);
    } catch (error) {
      console.error('[Auth Router] Profile fetch error:', error);
      return res.status(500).json({ error: 'Failed to retrieve profile.' });
    }
  });

  return router;
}

module.exports = {
  createAuthRouter
};
