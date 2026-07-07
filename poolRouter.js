/**
 * poolRouter.js
 * Multi-tenant Express router handling CRUD for personal_upi_pool database entries,
 * aggregation of stats, and transaction log fetching scoped to authenticated users.
 */

const express = require('express');
const { authenticateToken } = require('./authMiddleware');

/**
 * Creates the Express pool router.
 * @param {import('pg').Pool} dbPool PostgreSQL connection pool wrapper.
 * @returns {express.Router} Configured Express router.
 */
function createPoolRouter(dbPool) {
  const router = express.Router();

  const getDb = () => {
    const activeDb = (dbPool && dbPool.pool) ? dbPool.pool : dbPool;
    if (!activeDb) throw new Error('Database pool not initialized.');
    return activeDb;
  };

  // Protect all pool routes with JWT authentication
  router.use(authenticateToken);

  // ==========================================
  // GET /api/pool
  // Lists all UPI pool accounts belonging to the authenticated merchant
  // ==========================================
  router.get('/', async (req, res) => {
    try {
      const query = `
        SELECT p.upi_id, p.account_holder, p.daily_amount_limit, p.daily_count_limit, 
               p.current_amount, p.current_count, p.is_active, p.weight, p.cooldown_until, p.last_ping,
               COALESCE(t.total_requests, 0)::int as total_requests,
               COALESCE(t.approved_requests, 0)::int as approved_requests,
               COALESCE(t.total_approved_volume, 0)::numeric as total_approved_volume
        FROM personal_upi_pool p
        LEFT JOIN (
          SELECT assigned_upi,
                 COUNT(*) as total_requests,
                 COUNT(*) FILTER (WHERE status = 'APPROVED') as approved_requests,
                 SUM(final_amount) FILTER (WHERE status = 'APPROVED') as total_approved_volume
          FROM transaction_logs
          GROUP BY assigned_upi
        ) t ON p.upi_id = t.assigned_upi
        WHERE p.user_id = $1
        ORDER BY p.upi_id;
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      return res.status(200).json(dbRes.rows);
    } catch (error) {
      console.error('[Pool Router] Error listing pool accounts:', error);
      return res.status(500).json({ error: 'Failed to fetch UPI pool accounts.' });
    }
  });

  // ==========================================
  // POST /api/pool
  // Adds a new UPI account to the merchant's pool
  // ==========================================
  router.post('/', async (req, res) => {
    const { upiId, accountHolder, dailyAmountLimit, dailyCountLimit, weight } = req.body;

    // Validation
    if (!upiId || !accountHolder) {
      return res.status(400).json({ error: 'upiId and accountHolder are required.' });
    }

    if (!upiId.includes('@')) {
      return res.status(400).json({ error: 'Invalid UPI ID format. VPA must contain @ (e.g. user@bank).' });
    }

    const amountLimit = parseFloat(dailyAmountLimit) || 100000.00;
    const countLimit = parseInt(dailyCountLimit) || 20;
    const routeWeight = Math.max(1, parseInt(weight) || 1);

    try {
      const query = `
        INSERT INTO personal_upi_pool (upi_id, user_id, account_holder, daily_amount_limit, daily_count_limit, current_amount, current_count, is_active, weight)
        VALUES ($1, $2, $3, $4, $5, 0.00, 0, TRUE, $6)
        RETURNING *;
      `;
      const dbRes = await getDb().query(query, [upiId.trim(), req.user.id, accountHolder.trim(), amountLimit, countLimit, routeWeight]);
      return res.status(201).json(dbRes.rows[0]);
    } catch (error) {
      if (error.code === '23505') { // Unique violation
        return res.status(409).json({ error: `UPI ID ${upiId} is already in use by a pool.` });
      }
      console.error('[Pool Router] Error creating pool account:', error);
      return res.status(500).json({ error: 'Failed to create UPI pool account.' });
    }
  });

  // ==========================================
  // PATCH /api/pool/:id
  // Updates limits or active state of a UPI account
  // ==========================================
  router.patch('/:id', async (req, res) => {
    const upiId = req.params.id;
    const { dailyAmountLimit, dailyCountLimit, isActive, weight } = req.body;

    try {
      // 1. Verify VPA ownership
      const selectQuery = `SELECT daily_amount_limit, daily_count_limit, is_active, weight FROM personal_upi_pool WHERE upi_id = $1 AND user_id = $2`;
      const checkRes = await getDb().query(selectQuery, [upiId, req.user.id]);

      if (checkRes.rows.length === 0) {
        return res.status(404).json({ error: `UPI account ${upiId} not found in your pool.` });
      }

      const current = checkRes.rows[0];
      const updatedAmountLimit = dailyAmountLimit !== undefined ? parseFloat(dailyAmountLimit) : parseFloat(current.daily_amount_limit);
      const updatedCountLimit = dailyCountLimit !== undefined ? parseInt(dailyCountLimit) : parseInt(current.daily_count_limit);
      const updatedIsActive = isActive !== undefined ? !!isActive : current.is_active;
      const updatedWeight = weight !== undefined ? Math.max(1, parseInt(weight)) : current.weight;

      const updateQuery = `
        UPDATE personal_upi_pool
        SET daily_amount_limit = $1,
            daily_count_limit = $2,
            is_active = $3,
            weight = $4
        WHERE upi_id = $5 AND user_id = $6
        RETURNING *;
      `;

      const dbRes = await getDb().query(updateQuery, [updatedAmountLimit, updatedCountLimit, updatedIsActive, updatedWeight, upiId, req.user.id]);
      return res.status(200).json(dbRes.rows[0]);
    } catch (error) {
      console.error('[Pool Router] Error updating pool account:', error);
      return res.status(500).json({ error: 'Failed to update UPI pool account.' });
    }
  });

  // ==========================================
  // DELETE /api/pool/:id
  // Removes a UPI account from the merchant's pool
  // ==========================================
  router.delete('/:id', async (req, res) => {
    const upiId = req.params.id;

    try {
      // 1. Verify VPA ownership
      const checkQuery = `SELECT upi_id FROM personal_upi_pool WHERE upi_id = $1 AND user_id = $2`;
      const checkRes = await getDb().query(checkQuery, [upiId, req.user.id]);
      if (checkRes.rows.length === 0) {
        return res.status(404).json({ error: `UPI account ${upiId} not found in your pool.` });
      }

      const deleteQuery = `DELETE FROM personal_upi_pool WHERE upi_id = $1 AND user_id = $2`;
      await getDb().query(deleteQuery, [upiId, req.user.id]);
      return res.status(200).json({ success: true, message: `UPI account ${upiId} removed from pool.` });
    } catch (error) {
      if (error.code === '23503') { // Foreign key constraint violation
        return res.status(409).json({ 
          error: `Cannot delete VPA ${upiId} because it is referenced in past transaction logs. Make it inactive instead.` 
        });
      }
      console.error('[Pool Router] Error deleting pool account:', error);
      return res.status(500).json({ error: 'Failed to delete UPI pool account.' });
    }
  });

  // ==========================================
  // GET /api/pool/stats
  // Aggregates dashboard health metrics for today scoped to current user
  // ==========================================
  router.get('/stats', async (req, res) => {
    try {
      // 1. Scoped revenue and approved count today
      const revenueQuery = `
        SELECT COALESCE(SUM(final_amount), 0.00) as revenue, COUNT(*) as count 
        FROM transaction_logs 
        WHERE user_id = $1 AND status = 'APPROVED' AND created_at >= CURRENT_DATE;
      `;
      const revRes = await getDb().query(revenueQuery, [req.user.id]);
      const revenue = parseFloat(revRes.rows[0].revenue);
      const approvedCount = parseInt(revRes.rows[0].count);

      // 2. Scoped pending count
      const pendingQuery = `
        SELECT COUNT(*) as count FROM transaction_logs WHERE user_id = $1 AND status = 'PENDING';
      `;
      const pendRes = await getDb().query(pendingQuery, [req.user.id]);
      const pendingCount = parseInt(pendRes.rows[0].count);

      // 3. Scoped active VPA accounts
      const activeVpasQuery = `
        SELECT COUNT(*) as count FROM personal_upi_pool WHERE user_id = $1 AND is_active = TRUE;
      `;
      const actRes = await getDb().query(activeVpasQuery, [req.user.id]);
      const activeCount = parseInt(actRes.rows[0].count);

      // 4. Combined pools limits headroom vs total pools capacity scoped
      const limitsQuery = `
        SELECT COALESCE(SUM(daily_amount_limit), 0.00) as total_limit,
               COALESCE(SUM(current_amount), 0.00) as total_used
        FROM personal_upi_pool
        WHERE user_id = $1 AND is_active = TRUE;
      `;
      const limRes = await getDb().query(limitsQuery, [req.user.id]);
      const totalLimit = parseFloat(limRes.rows[0].total_limit);
      const totalUsed = parseFloat(limRes.rows[0].total_used);

      return res.status(200).json({
        revenueToday: revenue,
        approvedTransactionsToday: approvedCount,
        pendingTransactions: pendingCount,
        activeVpaCount: activeCount,
        totalLimit: totalLimit,
        totalUsed: totalUsed,
        headroomRemaining: Math.max(0, totalLimit - totalUsed)
      });
    } catch (error) {
      console.error('[Pool Router] Error fetching metrics:', error);
      return res.status(500).json({ error: 'Failed to fetch gateway statistics.' });
    }
  });

  // ==========================================
  // GET /api/pool/transactions
  // Lists recent transactions belonging to current user (limit 50)
  // ==========================================
  router.get('/transactions', async (req, res) => {
    try {
      const query = `
        SELECT order_id, base_amount, final_amount, assigned_upi, status, utr_number, expires_at, created_at
        FROM transaction_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50;
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      return res.status(200).json(dbRes.rows);
    } catch (error) {
      console.error('[Pool Router] Error listing transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch recent transactions.' });
    }
  });

  // ==========================================
  // GET /api/pool/webhook-logs
  // Lists webhook delivery history logs scoped to merchant
  // ==========================================
  router.get('/webhook-logs', async (req, res) => {
    try {
      const query = `
        SELECT id, order_id, url, event_type, payload, response_code, response_body, success, created_at
        FROM webhook_delivery_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50;
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      return res.status(200).json(dbRes.rows);
    } catch (error) {
      console.error('[Pool Router] Error listing webhook delivery logs:', error);
      return res.status(500).json({ error: 'Failed to fetch webhook delivery logs.' });
    }
  });

  // ==========================================
  // POST /api/pool/webhook-logs/:id/retry
  // Retries sending a webhook for a specific delivery log scoped to merchant
  // ==========================================
  router.post('/webhook-logs/:id/retry', async (req, res) => {
    const { id } = req.params;
    try {
      // 1. Fetch webhook delivery log
      const logQuery = 'SELECT order_id FROM webhook_delivery_logs WHERE id = $1 AND user_id = $2';
      const logRes = await getDb().query(logQuery, [id, req.user.id]);
      if (logRes.rows.length === 0) {
        return res.status(404).json({ error: 'Webhook log entry not found or unauthorized.' });
      }
      const orderId = logRes.rows[0].order_id;

      // 2. Fetch the corresponding transaction details
      const txnQuery = 'SELECT order_id, base_amount, final_amount, assigned_upi, status, utr_number FROM transaction_logs WHERE order_id = $1 AND user_id = $2';
      const txnRes = await getDb().query(txnQuery, [orderId, req.user.id]);
      if (txnRes.rows.length === 0) {
        return res.status(404).json({ error: 'Matching transaction log details not found.' });
      }

      // 3. Re-trigger webhook dispatcher
      const { triggerWebhook } = require('./webhookDispatcher');
      await triggerWebhook(req.user.id, txnRes.rows[0], getDb());

      return res.status(200).json({ success: true, message: `Webhook retry event successfully dispatched for order #${orderId}.` });
    } catch (error) {
      console.error('[Pool Router] Error retrying webhook delivery:', error);
      return res.status(500).json({ error: 'Failed to retry webhook delivery.' });
    }
  });

  // ==========================================
  // POST /api/pool/reset-limits
  // Manual admin sweep helper to reset all daily amount/count usage trackers to 0
  // ==========================================
  router.post('/reset-limits', async (req, res) => {
    try {
      const query = `
        UPDATE personal_upi_pool
        SET current_amount = 0.00,
            current_count = 0
        WHERE user_id = $1
        RETURNING upi_id, account_holder, current_amount, current_count;
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      return res.status(200).json({
        success: true,
        message: 'Daily VPA pool limits and transaction counts manually reset successfully!',
        resetsCount: dbRes.rowCount,
        pools: dbRes.rows
      });
    } catch (error) {
      console.error('[Pool Router] Error manually resetting daily limits:', error);
      return res.status(500).json({ error: 'Failed to manually reset UPI VPA pool daily limits.' });
    }
  });

  // ==========================================
  // GET /api/pool/unmatched-payments
  // Lists recent unmatched payment alerts (paise matching assistant)
  // ==========================================
  router.get('/unmatched-payments', async (req, res) => {
    try {
      const query = `
        SELECT id, amount, utr_number, sender, message, resolved, resolved_order_id, created_at
        FROM unmatched_payments
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50;
      `;
      const dbRes = await getDb().query(query, [req.user.id]);
      return res.status(200).json(dbRes.rows);
    } catch (error) {
      console.error('[Pool Router] Error listing unmatched payments:', error);
      return res.status(500).json({ error: 'Failed to fetch unmatched payments.' });
    }
  });

  // ==========================================
  // POST /api/pool/unmatched-payments/:id/reconcile
  // Force-reconciles an unmatched alert with a pending order
  // ==========================================
  router.post('/unmatched-payments/:id/reconcile', async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'Missing target Order ID for manual matching.' });
    }

    const client = await getDb().connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch the unmatched alert details
      const unmatchedRes = await client.query(
        `SELECT amount, utr_number, sender, message, resolved FROM unmatched_payments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [req.params.id, req.user.id]
      );

      if (unmatchedRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Unmatched payment alert not found.' });
      }

      const unmatchedAlert = unmatchedRes.rows[0];
      if (unmatchedAlert.resolved) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unmatched payment alert is already resolved.' });
      }

      // 2. Fetch the target PENDING transaction log
      const txnRes = await client.query(
        `SELECT order_id, base_amount, final_amount, assigned_upi FROM transaction_logs WHERE order_id = $1 AND user_id = $2 AND status = 'PENDING' FOR UPDATE`,
        [orderId, req.user.id]
      );

      if (txnRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Target pending transaction log not found for this Order ID.' });
      }

      const txn = txnRes.rows[0];

      // 2b. Amount validation
      const unmatchedAmount = parseFloat(unmatchedAlert.amount);
      const txnAmount = parseFloat(txn.final_amount);
      const baseAmount = parseFloat(txn.base_amount || txn.final_amount);
      if (Math.abs(unmatchedAmount - txnAmount) > 1.0 && Math.abs(unmatchedAmount - baseAmount) > 1.0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Amount mismatch: received ₹${unmatchedAmount.toFixed(2)} but order expects ₹${txnAmount.toFixed(2)}.` });
      }

      // 2c. Duplicate UTR check
      if (unmatchedAlert.utr_number) {
        const dupeCheck = await db.query('SELECT order_id FROM transaction_logs WHERE user_id = $1 AND utr_number = $2 AND status = $3', [req.user.id, unmatchedAlert.utr_number, 'APPROVED']);
        if (dupeCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `UTR ${unmatchedAlert.utr_number} already used for order ${dupeCheck.rows[0].order_id}.` });
        }
      }

      // 3. Mark transaction as APPROVED & attach UTR
      await client.query(
        `UPDATE transaction_logs SET status = 'APPROVED', utr_number = $1 WHERE order_id = $2 AND user_id = $3`,
        [unmatchedAlert.utr_number, orderId, req.user.id]
      );

      // 4. Update the unmatched alert as resolved
      await client.query(
        `UPDATE unmatched_payments SET resolved = TRUE, resolved_order_id = $1 WHERE id = $2`,
        [orderId, req.params.id]
      );

      // 5. Update limits/trackers on the assigned VPA pool account
      if (txn.assigned_upi) {
        await client.query(
          `UPDATE personal_upi_pool SET current_amount = current_amount + $1, current_count = current_count + 1 WHERE upi_id = $2 AND user_id = $3`,
          [txn.final_amount, txn.assigned_upi, req.user.id]
        );
      }

      await client.query('COMMIT');

      // 6. Post-transaction hooks (trigger background webhook dispatcher and Shopify callback markers)
      try {
        const { triggerWebhook } = require('./webhookDispatcher');
        triggerWebhook(req.user.id, {
          order_id: orderId,
          base_amount: txn.base_amount,
          final_amount: txn.final_amount,
          assigned_upi: txn.assigned_upi,
          status: 'APPROVED',
          utr_number: unmatchedAlert.utr_number
        }, getDb());
      } catch (webhookErr) {
        console.error('[Manual Reconcile] Webhook dispatch error:', webhookErr.message);
      }

      // Shopify callback
      try {
        const userRes = await getDb().query(
          `SELECT shopify_store, shopify_token FROM users WHERE id = $1`,
          [req.user.id]
        );
        if (userRes.rows.length > 0 && userRes.rows[0].shopify_store && userRes.rows[0].shopify_token) {
          const { orderMarkAsPaid } = require('./shopifyService');
          orderMarkAsPaid(orderId, userRes.rows[0].shopify_store, userRes.rows[0].shopify_token)
            .then(ok => {
              if (ok) console.log(`[Manual Reconcile] Shopify marked order ${orderId} as PAID.`);
            })
            .catch(err => console.error('[Manual Reconcile] Shopify callback crash:', err));
        }
      } catch (shopErr) {
        console.error('[Manual Reconcile] Shopify store details fetch failed:', shopErr.message);
      }

      return res.status(200).json({
        success: true,
        message: `Order #${orderId} has been manually reconciled and approved successfully!`
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Pool Router] Manual reconcile error:', error);
      return res.status(500).json({ error: 'Manual reconciliation process failed.' });
    } finally {
      client.release();
    }
  });

  // ==========================================
  // POST /api/pool/unmatched-payments/:id/resolve
  // Resolves / Dismisses an unmatched alert manually
  // ==========================================
  router.post('/unmatched-payments/:id/resolve', async (req, res) => {
    try {
      const query = `
        UPDATE unmatched_payments
        SET resolved = TRUE,
            resolved_order_id = 'DISMISSED'
        WHERE id = $1 AND user_id = $2
        RETURNING id;
      `;
      const dbRes = await getDb().query(query, [req.params.id, req.user.id]);
      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'Unmatched alert not found.' });
      }
      return res.status(200).json({
        success: true,
        message: 'Unmatched payment alert has been resolved/dismissed.'
      });
    } catch (error) {
      console.error('[Pool Router] Error resolving unmatched alert:', error);
      return res.status(500).json({ error: 'Failed to resolve unmatched payment alert.' });
    }
  });

  return router;
}

module.exports = {
  createPoolRouter
};
