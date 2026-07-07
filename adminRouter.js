/**
 * adminRouter.js
 * Admin portal routes to manage merchants, view system status, and configure multi-tenant rules.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken } = require('./authMiddleware');

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
}

/**
 * Creates the Admin Express router.
 * @param {import('pg').Pool} dbPool PostgreSQL connection pool.
 * @returns {express.Router} Configured admin router.
 */
function createAdminRouter(dbPool) {
  const router = express.Router();

  const getDb = () => {
    if (dbPool && typeof dbPool === 'object' && 'pool' in dbPool) {
      return dbPool.pool;
    }
    return dbPool;
  };

  // Apply admin checks globally on this router group
  router.use(authenticateToken);
  router.use(requireAdmin);

  // ==========================================
  // GET /api/admin/users
  // Fetch details of all merchants in the system with aggregated statistics
  // ==========================================
  router.get('/users', async (req, res) => {
    try {
      const query = `
        SELECT 
          u.id, 
          u.email, 
          u.shopify_store, 
          u.role, 
          u.created_at,
          COALESCE(p.vpa_count, 0) AS total_vpas,
          COALESCE(t.txn_count, 0) AS total_transactions,
          COALESCE(t.txn_volume, 0) AS total_volume
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS vpa_count 
          FROM personal_upi_pool 
          GROUP BY user_id
        ) p ON u.id = p.user_id
        LEFT JOIN (
          SELECT 
            user_id, 
            COUNT(*) AS txn_count, 
            SUM(final_amount) AS txn_volume 
          FROM transaction_logs 
          WHERE status = 'APPROVED'
          GROUP BY user_id
        ) t ON u.id = t.user_id
        ORDER BY u.id ASC;
      `;
      const dbRes = await getDb().query(query);
      return res.status(200).json(dbRes.rows);
    } catch (error) {
      console.error('[Admin Router] Failed to fetch users:', error);
      return res.status(500).json({ error: 'Database query failed.' });
    }
  });

  // ==========================================
  // POST /api/admin/users
  // Admin creates a new user account directly
  // ==========================================
  router.post('/users', async (req, res) => {
    const { email, password, shopify_store, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password parameters are required.' });
    }

    try {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      const apiKey = 'upi_live_' + require('crypto').randomBytes(24).toString('hex');
      
      const insertQuery = `
        INSERT INTO users (email, password_hash, shopify_store, role, api_key)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, role, shopify_store, created_at;
      `;
      const dbRes = await getDb().query(insertQuery, [
        email.trim().toLowerCase(),
        passwordHash,
        shopify_store ? shopify_store.trim() : null,
        role || 'merchant',
        apiKey
      ]);

      return res.status(201).json({
        message: 'User account created successfully by Admin.',
        user: dbRes.rows[0]
      });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Email or Shopify store domain is already registered.' });
      }
      console.error('[Admin Router] Create user error:', error);
      return res.status(500).json({ error: 'Failed to create user account.' });
    }
  });

  // ==========================================
  // POST /api/admin/users/:userId/change-password
  // Admin overrides a merchant user's password
  // ==========================================
  router.post('/users/:userId/change-password', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { newPassword } = req.body;

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    try {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);

      const updateQuery = `
        UPDATE users 
        SET password_hash = $1 
        WHERE id = $2
        RETURNING id, email;
      `;
      const dbRes = await getDb().query(updateQuery, [passwordHash, userId]);

      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }

      return res.status(200).json({
        message: `Password updated successfully for user ID #${userId}.`
      });
    } catch (error) {
      console.error('[Admin Router] Change password error:', error);
      return res.status(500).json({ error: 'Failed to reset password.' });
    }
  });

  // ==========================================
  // DELETE /api/admin/users/:userId
  // Admin deletes a merchant user account
  // ==========================================
  router.delete('/users/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Administrators cannot delete their own active session profile.' });
    }

    try {
      const deleteQuery = `DELETE FROM users WHERE id = $1 RETURNING id, email;`;
      const dbRes = await getDb().query(deleteQuery, [userId]);

      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'User account not found.' });
      }

      return res.status(200).json({
        message: `User account '${dbRes.rows[0].email}' deleted successfully.`
      });
    } catch (error) {
      console.error('[Admin Router] Delete user error:', error);
      return res.status(500).json({ error: 'Failed to delete user account.' });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter
};
