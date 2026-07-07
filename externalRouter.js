/**
 * externalRouter.js
 * Multi-tenant Express router providing developer API integrations.
 * Supports API Key validation, payment initiation, and payment checks.
 */

const express = require('express');

/**
 * Creates the external Developer API Router.
 * @param {object} dbPool Central database connection pool wrapper.
 * @returns {express.Router} Configured Express router.
 */
function createExternalRouter(dbPool) {
  const router = express.Router();

  const getDb = () => {
    const activeDb = (dbPool && dbPool.pool) ? dbPool.pool : dbPool;
    if (!activeDb) throw new Error('Database pool not initialized.');
    return activeDb;
  };

  // Auth Middleware using X-API-Key or Authorization Bearer header
  const authenticateApiKey = async (req, res, next) => {
    let apiKey = req.headers['x-api-key'] || req.headers['api-key'];
    
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      apiKey = authHeader.substring(7);
    }

    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized. API Key is missing.' });
    }

    try {
      const query = 'SELECT id, email, business_name, logo_url, checkout_primary_color, checkout_bg_color, checkout_timer_minutes, gateway_url FROM users WHERE api_key = $1';
      const dbRes = await getDb().query(query, [apiKey.trim()]);
      if (dbRes.rows.length === 0) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API Key.' });
      }

      req.user = dbRes.rows[0];
      next();
    } catch (err) {
      console.error('[External Auth] Database check crash:', err.message);
      return res.status(500).json({ error: 'Internal Auth Validation Error.' });
    }
  };

  // POST /api/external/pay/initiate - Creates a new transaction
  router.post('/pay/initiate', authenticateApiKey, async (req, res) => {
    const { orderId, amount } = req.body;
    const userId = req.user.id;

    if (!orderId || !amount) {
      return res.status(400).json({ error: 'Missing required parameters: orderId and amount.' });
    }

    const baseAmountNum = parseFloat(amount);
    if (isNaN(baseAmountNum) || baseAmountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
    }

    const client = await getDb().connect();

    try {
      await client.query('BEGIN');

      // 1. Check if an active PENDING transaction already exists
      const existingQuery = `
        SELECT order_id, base_amount, final_amount, assigned_upi, status, expires_at, cancel_at, 
               p.account_holder
        FROM transaction_logs t
        JOIN personal_upi_pool p ON t.assigned_upi = p.upi_id
        WHERE t.order_id = $1 AND t.user_id = $2 AND t.status = 'PENDING' AND t.expires_at > NOW();
      `;
      const existingRes = await client.query(existingQuery, [orderId, userId]);
      if (existingRes.rows.length > 0) {
        const txn = existingRes.rows[0];
        await client.query('COMMIT');
        
        const payeeName = req.user.business_name || txn.account_holder;
        const upiUri = `upi://pay?pa=${encodeURIComponent(txn.assigned_upi)}&pn=${encodeURIComponent(payeeName)}&am=${txn.final_amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(txn.order_id)}`;
        
        const baseUrl = (req.user.gateway_url || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
        const checkoutUrl = `${baseUrl}/checkout/${encodeURIComponent(txn.order_id)}`;

        return res.status(200).json({
          success: true,
          orderId: txn.order_id,
          baseAmount: parseFloat(txn.base_amount),
          finalAmount: parseFloat(txn.final_amount),
          assignedUpi: txn.assigned_upi,
          upiString: upiUri,
          checkoutUrl: checkoutUrl,
          expiresAt: txn.expires_at,
          status: txn.status
        });
      }

      // 2. Find active UPI accounts with daily capacity headroom (and not in cooldown)
      const upiPoolQuery = `
        SELECT upi_id, account_holder, daily_amount_limit, daily_count_limit, current_amount, current_count, weight
        FROM personal_upi_pool
        WHERE user_id = $1 AND is_active = TRUE 
          AND (current_amount + $2) <= daily_amount_limit
          AND (current_count + 1) <= daily_count_limit
          AND (cooldown_until IS NULL OR cooldown_until < CURRENT_TIMESTAMP)
        FOR UPDATE;
      `;
      const upiRes = await client.query(upiPoolQuery, [userId, baseAmountNum]);
      if (upiRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({
          error: 'No active UPI accounts are available in your pool with sufficient daily limit headroom or active status.'
        });
      }

      // Apply Weighted Random Selection on candidates
      let selectedVpa = null;
      const candidates = upiRes.rows;
      if (candidates.length === 1) {
        selectedVpa = candidates[0];
      } else {
        const totalWeight = candidates.reduce((sum, v) => sum + Math.max(1, v.weight), 0);
        let random = Math.random() * totalWeight;
        for (const vpa of candidates) {
          random -= Math.max(1, vpa.weight);
          if (random <= 0) {
            selectedVpa = vpa;
            break;
          }
        }
        if (!selectedVpa) selectedVpa = candidates[0];
      }

      const assignedUpi = selectedVpa.upi_id;
      const accountHolder = selectedVpa.account_holder;

      // 3. Resolve a unique paise fraction (.01 to .99) not currently in PENDING state for this user
      const activeFractionsQuery = `
        SELECT ROUND(final_amount - base_amount, 2) AS fraction 
        FROM transaction_logs 
        WHERE user_id = $1 AND status = 'PENDING'
      `;
      const activeFractionsRes = await client.query(activeFractionsQuery, [userId]);
      const activeFractions = new Set(activeFractionsRes.rows.map(r => parseFloat(r.fraction)));

      let selectedPaise = -1;
      for (let paise = 1; paise <= 99; paise++) {
        const fraction = parseFloat((paise / 100).toFixed(2));
        if (!activeFractions.has(fraction)) {
          selectedPaise = fraction;
          break;
        }
      }

      if (selectedPaise === -1) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Transaction volume threshold reached. All paise fingerprint variations (.01 - .99) are currently occupied. Please wait for expiries.'
        });
      }

      const finalAmount = parseFloat((baseAmountNum + selectedPaise).toFixed(2));
      const limitMins = parseInt(req.user.checkout_timer_minutes || 7);
      const expiresAt = new Date(Date.now() + limitMins * 60 * 1000);
      const cancelAt = new Date(Date.now() + (limitMins + 13) * 60 * 1000);  // 13-minute buffer for SMS delays

      // 4. Log transaction
      const insertQuery = `
        INSERT INTO transaction_logs (order_id, user_id, base_amount, final_amount, assigned_upi, status, expires_at, cancel_at)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
        RETURNING order_id, base_amount, final_amount, assigned_upi, status, expires_at;
      `;
      const insertRes = await client.query(insertQuery, [
        orderId,
        userId,
        baseAmountNum,
        finalAmount,
        assignedUpi,
        expiresAt,
        cancelAt
      ]);

      await client.query('COMMIT');
      const txn = insertRes.rows[0];

      const payeeName = req.user.business_name || accountHolder;
      const upiUri = `upi://pay?pa=${encodeURIComponent(assignedUpi)}&pn=${encodeURIComponent(payeeName)}&am=${finalAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(orderId)}`;
      
      const baseUrl = (req.user.gateway_url || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
      const checkoutUrl = `${baseUrl}/checkout/${encodeURIComponent(orderId)}`;

      return res.status(201).json({
        success: true,
        orderId: txn.order_id,
        baseAmount: parseFloat(txn.base_amount),
        finalAmount: parseFloat(txn.final_amount),
        assignedUpi: txn.assigned_upi,
        upiString: upiUri,
        checkoutUrl: checkoutUrl,
        expiresAt: txn.expires_at,
        status: txn.status
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[External API] Initialization crash:', err.message);
      return res.status(500).json({ error: 'Database transaction failed during initialization.' });
    } finally {
      client.release();
    }
  });

  // GET /api/external/pay/status/:orderId - Returns transaction status
  router.get('/pay/status/:orderId', authenticateApiKey, async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;

    try {
      const query = `
        SELECT order_id, base_amount, final_amount, status, expires_at, utr_number, created_at
        FROM transaction_logs
        WHERE order_id = $1 AND user_id = $2
      `;
      const dbRes = await getDb().query(query, [orderId, userId]);
      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction not found.' });
      }

      const txn = dbRes.rows[0];
      return res.status(200).json({
        success: true,
        orderId: txn.order_id,
        baseAmount: parseFloat(txn.base_amount),
        finalAmount: parseFloat(txn.final_amount),
        status: txn.status,
        expiresAt: txn.expires_at,
        utrNumber: txn.utr_number || null,
        createdAt: txn.created_at
      });
    } catch (err) {
      console.error('[External API] Check status crash:', err.message);
      return res.status(500).json({ error: 'Database query failed.' });
    }
  });

  return router;
}

module.exports = {
  createExternalRouter
};
