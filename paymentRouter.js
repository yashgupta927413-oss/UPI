/**
 * paymentRouter.js
 * Multi-tenant Express router handling payment initiation, status checks, 
 * SMS webhook reconciliation, and Shopify cancellation webhooks.
 */

const express = require('express');
const { parseCreditSMS } = require('./smsParser');
const { orderMarkAsPaid } = require('./shopifyService');

/**
 * Creates the Express payment router.
 * @param {import('pg').Pool} dbPool PostgreSQL connection pool wrapper.
 * @returns {express.Router} Configured Express router.
 */
function createPaymentRouter(dbPool) {
  const router = express.Router();

  const getDb = () => {
    const activeDb = (dbPool && dbPool.pool) ? dbPool.pool : dbPool;
    if (!activeDb) throw new Error('Database pool not initialized.');
    return activeDb;
  };

  // ==========================================
  // POST /api/pay/initiate-frictionless
  // Initiates a UPI payment using paise-level fingerprinting per user
  // ==========================================
  router.post('/initiate-frictionless', async (req, res) => {
    const { orderId, baseAmount, shopDomain } = req.body;

    // Validation
    if (!orderId || !baseAmount || !shopDomain) {
      return res.status(400).json({ 
        error: 'Missing required parameters: orderId, baseAmount, and shopDomain.' 
      });
    }

    const baseAmountNum = parseFloat(baseAmount);
    if (isNaN(baseAmountNum) || baseAmountNum <= 0) {
      return res.status(400).json({ 
        error: 'Invalid baseAmount. Must be a positive number.' 
      });
    }

    const client = await getDb().connect();

    try {
      await client.query('BEGIN');

      // 1. Identify the merchant user associated with this shopify store domain
      const userQuery = `SELECT id, email, business_name, logo_url, checkout_primary_color, checkout_bg_color, checkout_timer_minutes FROM users WHERE shopify_store = $1`;
      const userRes = await client.query(userQuery, [shopDomain.trim().toLowerCase()]);
      
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: `The Shopify store domain "${shopDomain}" is not registered on this gateway.`
        });
      }

      const userId = userRes.rows[0].id;

      // 2. Check if an active PENDING transaction already exists for this orderId and user
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
        
        const upiUri = `upi://pay?pa=${encodeURIComponent(txn.assigned_upi)}&pn=${encodeURIComponent(txn.account_holder)}&am=${txn.final_amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(txn.order_id)}`;
        
        return res.status(200).json({
          orderId: txn.order_id,
          baseAmount: parseFloat(txn.base_amount),
          finalAmount: parseFloat(txn.final_amount),
          assignedUpi: txn.assigned_upi,
          upiString: upiUri,
          expiresAt: txn.expires_at,
          cancelAt: txn.cancel_at,
          status: txn.status,
          businessName: userRes.rows[0].business_name,
          logoUrl: userRes.rows[0].logo_url,
          primaryColor: userRes.rows[0].checkout_primary_color,
          bgColor: userRes.rows[0].checkout_bg_color
        });
      }

      // 3. Find active UPI accounts belonging to this user with capacity headroom (and not in cooldown)
      const upiPoolQuery = `
        SELECT upi_id, account_holder, daily_amount_limit, daily_count_limit, current_amount, current_count, weight
        FROM personal_upi_pool
        WHERE user_id = $1 AND is_active = TRUE 
          AND (current_amount + $2) <= daily_amount_limit
          AND current_count < daily_count_limit
          AND (cooldown_until IS NULL OR cooldown_until < CURRENT_TIMESTAMP)
        FOR UPDATE; -- lock the rows
      `;
      const upiRes = await client.query(upiPoolQuery, [userId, baseAmountNum]);

      if (upiRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({
          error: 'No active UPI accounts in your pool have capacity headroom or are active. Please try again later.'
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

      const assignedUpi = selectedVpa;
      const upiId = assignedUpi.upi_id;
      const accountHolder = assignedUpi.account_holder;

      // 4. Find an available paise fraction (.01 to .99) not currently in 'PENDING' status for this user
      const startRange = Math.floor(baseAmountNum);
      const endRange = startRange + 1;

      const activeAmountsQuery = `
        SELECT final_amount FROM transaction_logs
        WHERE user_id = $1 AND status = 'PENDING'
          AND final_amount >= $2 AND final_amount < $3;
      `;
      const activeAmountsRes = await client.query(activeAmountsQuery, [userId, startRange, endRange]);
      const takenAmounts = new Set(
        activeAmountsRes.rows.map(row => parseFloat(row.final_amount).toFixed(2))
      );

      let selectedFraction = null;
      let finalAmount = null;

      // Loop from .01 to .99 to find the first unused fraction
      for (let i = 1; i <= 99; i++) {
        const fraction = i / 100;
        const candidateAmount = (startRange + fraction).toFixed(2);
        if (!takenAmounts.has(candidateAmount)) {
          selectedFraction = fraction;
          finalAmount = parseFloat(candidateAmount);
          break;
        }
      }

      if (selectedFraction === null) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'All paise fractional combinations for this amount are currently active. Try again in a few minutes.'
        });
      }

      // 5. Create the transaction log associated with the user using the user's custom checkout timer limit
      const limitMins = parseInt(userRes.rows[0].checkout_timer_minutes || 7);
      const expiresAt = new Date(Date.now() + limitMins * 60 * 1000);
      const cancelAt = new Date(Date.now() + (limitMins + 13) * 60 * 1000); // 13-minute buffer for SMS delays

      const insertQuery = `
        INSERT INTO transaction_logs (order_id, user_id, base_amount, final_amount, assigned_upi, status, expires_at, cancel_at)
        VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
        RETURNING order_id, base_amount, final_amount, assigned_upi, status, expires_at, cancel_at;
      `;
      const insertRes = await client.query(insertQuery, [
        orderId,
        userId,
        baseAmountNum,
        finalAmount,
        upiId,
        expiresAt,
        cancelAt
      ]);

      await client.query('COMMIT');

      const txn = insertRes.rows[0];
      const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(accountHolder)}&am=${finalAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(orderId)}`;

      return res.status(201).json({
        orderId: txn.order_id,
        baseAmount: parseFloat(txn.base_amount),
        finalAmount: parseFloat(txn.final_amount),
        assignedUpi: txn.assigned_upi,
        upiString: upiUri,
        expiresAt: txn.expires_at,
        cancelAt: txn.cancel_at,
        status: txn.status,
        businessName: userRes.rows[0].business_name,
        logoUrl: userRes.rows[0].logo_url,
        primaryColor: userRes.rows[0].checkout_primary_color,
        bgColor: userRes.rows[0].checkout_bg_color
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Payment Router] Error initiating payment:', error);
      return res.status(500).json({ error: 'Database transaction failed during initialization.' });
    } finally {
      client.release();
    }
  });

  // ==========================================
  // GET /api/pay/check-status
  // Returns current payment state for a given orderId (globally unique)
  // ==========================================
  router.get('/check-status', async (req, res) => {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId parameter.' });
    }

    try {
      const query = `
        SELECT order_id, base_amount, final_amount, status, expires_at, cancel_at, utr_number
        FROM transaction_logs
        WHERE order_id = $1;
      `;
      const dbRes = await getDb().query(query, [orderId]);

      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction not found.' });
      }

      return res.status(200).json(dbRes.rows[0]);
    } catch (error) {
      console.error('[Payment Router] Error checking status:', error);
      return res.status(500).json({ error: 'Database query failed.' });
    }
  });

  // ==========================================
  // POST /api/pay/sms-webhook/:userId/:assignedUpi?
  // Receives SMS forwarded from Android device for a specific user profile and optional UPI ID
  // ==========================================
  router.post('/sms-webhook/:userId/:assignedUpi?', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const assignedUpiParam = req.params.assignedUpi;
    const smsBody = req.body.body || req.body.message || req.body.text || req.body.sms;

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid or missing user ID in URL path.' });
    }

    // Authenticate request using user's API Key (Fix #3)
    let apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.query.apiKey || req.query.token || req.body.apiKey || req.body.token;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      apiKey = authHeader.substring(7);
    }

    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized. API Key is missing.' });
    }

    try {
      const authRes = await getDb().query('SELECT api_key FROM users WHERE id = $1', [userId]);
      if (authRes.rows.length === 0) {
        return res.status(404).json({ error: 'Merchant user not found.' });
      }
      if (!authRes.rows[0].api_key || authRes.rows[0].api_key !== apiKey.trim()) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API Key.' });
      }
    } catch (err) {
      console.error('[SMS Webhook Auth] DB check failed:', err.message);
      return res.status(500).json({ error: 'Internal validation failure.' });
    }

    if (!smsBody) {
      return res.status(400).json({ error: 'Missing SMS body parameter.' });
    }

    const targetUpi = assignedUpiParam || req.query.upiId || req.query.upi || req.body.upiId || req.body.upi || null;

    console.log(`[SMS Webhook - User #${userId}${targetUpi ? ` - UPI ${targetUpi}` : ''}] Received SMS: "${smsBody}"`);

    // Parse credit details from SMS
    const parsed = parseCreditSMS(smsBody);
    if (!parsed) {
      console.log(`[SMS Webhook - User #${userId}] SMS parsed as non-credit or failed to match patterns.`);
      return res.status(200).json({ 
        success: true, 
        matched: false, 
        message: 'SMS did not match transaction credit formats.' 
      });
    }

    const { amount, utr, bank } = parsed;
    console.log(`[SMS Webhook - User #${userId}] Matches Credit! Bank: ${bank}, Amount: Rs. ${amount}, UTR: ${utr}`);

    const client = await getDb().connect();

    try {
      await client.query('BEGIN');

      // 1. Retrieve the merchant user's credentials to make the Shopify update call later
      const merchantQuery = `SELECT id, shopify_store, shopify_token FROM users WHERE id = $1`;
      const merchantRes = await client.query(merchantQuery, [userId]);
      
      if (merchantRes.rows.length === 0) {
        await client.query('ROLLBACK');
        console.error(`[SMS Webhook] Merchant user ID #${userId} not found in database.`);
        return res.status(404).json({ error: 'Merchant user not found.' });
      }
      
      const merchant = merchantRes.rows[0];

      // 2. Check if UTR is already processed for this user to prevent duplicate updates
      const duplicateCheck = await client.query(
        `SELECT order_id FROM transaction_logs WHERE user_id = $1 AND utr_number = $2 AND status = 'APPROVED'`,
        [userId, utr]
      );

      if (duplicateCheck.rows.length > 0) {
        await client.query('COMMIT');
        console.log(`[SMS Webhook - User #${userId}] UTR ${utr} was already reconciled. Ignoring.`);
        return res.status(200).json({ 
          success: true, 
          reconciled: true, 
          message: `UTR ${utr} already processed.` 
        });
      }

      // 3. Find a PENDING transaction that exactly matches the user, credited amount, and optionally UPI ID
      let findTxnQuery = '';
      let queryParams = [];

      if (targetUpi) {
        findTxnQuery = `
          SELECT order_id, base_amount, final_amount, assigned_upi
          FROM transaction_logs
          WHERE user_id = $1 AND status = 'PENDING' AND final_amount = $2 AND assigned_upi = $3
          FOR UPDATE; -- lock the row
        `;
        queryParams = [userId, amount, targetUpi];
      } else {
        findTxnQuery = `
          SELECT order_id, base_amount, final_amount, assigned_upi
          FROM transaction_logs
          WHERE user_id = $1 AND status = 'PENDING' AND final_amount = $2
          FOR UPDATE; -- lock the row
        `;
        queryParams = [userId, amount];
      }

      const txnRes = await client.query(findTxnQuery, queryParams);

      if (txnRes.rows.length === 0) {
        await client.query('ROLLBACK');
        
        // Log to unmatched payments ledger
        const unmatchedClient = await getDb().connect();
        try {
          const checkUnmatched = await unmatchedClient.query(
            `SELECT id FROM unmatched_payments WHERE user_id = $1 AND utr_number = $2`,
            [userId, utr]
          );
          if (checkUnmatched.rows.length === 0) {
            const insertUnmatched = `
              INSERT INTO unmatched_payments (user_id, amount, utr_number, sender, message)
              VALUES ($1, $2, $3, $4, $5);
            `;
            await unmatchedClient.query(insertUnmatched, [
              userId,
              amount,
              utr,
              req.body.sender || 'UNKNOWN',
              smsBody
            ]);
            console.log(`[SMS Webhook - User #${userId}] Logged unmatched payment for amount: Rs. ${amount}. UTR: ${utr}`);
          }
        } catch (unmatchedErr) {
          console.error(`[SMS Webhook - User #${userId}] Failed to write to unmatched_payments:`, unmatchedErr.message);
        } finally {
          unmatchedClient.release();
        }

        return res.status(200).json({
          success: true,
          reconciled: false,
          message: `No active PENDING transaction found for Rs. ${amount}. Logged to Unmatched Payments.`
        });
      }

      const txn = txnRes.rows[0];
      const orderId = txn.order_id;
      const assignedUpi = txn.assigned_upi;

      // 4. Mark the transaction as APPROVED and save the UTR reference number
      const updateTxnQuery = `
        UPDATE transaction_logs
        SET status = 'APPROVED', utr_number = $1
        WHERE order_id = $2 AND user_id = $3;
      `;
      await client.query(updateTxnQuery, [utr, orderId, userId]);

      // 5. Increment limits/trackers on the assigned UPI pool account
      const updatePoolQuery = `
        UPDATE personal_upi_pool
        SET current_amount = current_amount + $1,
            current_count = current_count + 1
        WHERE upi_id = $2 AND user_id = $3;
      `;
      await client.query(updatePoolQuery, [amount, assignedUpi, userId]);

      await client.query('COMMIT');
      console.log(`[SMS Webhook - User #${userId}] Transaction reconciled successfully. Order: ${orderId}, UTR: ${utr}.`);

      // Trigger Webhook Alert callback for manual API integrations
      try {
        const { triggerWebhook } = require('./webhookDispatcher');
        triggerWebhook(userId, {
          order_id: orderId,
          base_amount: txn.base_amount,
          final_amount: txn.final_amount,
          assigned_upi: assignedUpi,
          status: 'APPROVED',
          utr_number: utr
        }, getDb());
      } catch (webhookErr) {
        console.error(`[SMS Webhook - User #${userId}] Error triggering Webhook alert:`, webhookErr.message);
      }

      // 6. Trigger Shopify order status update using the user's specific store domain and token
      orderMarkAsPaid(orderId, merchant.shopify_store, merchant.shopify_token)
        .then((success) => {
          if (success) {
            console.log(`[SMS Webhook - User #${userId}] Shopify marked order ${orderId} as PAID.`);
          } else {
            console.error(`[SMS Webhook - User #${userId}] Failed to mark order ${orderId} as PAID in Shopify.`);
          }
        })
        .catch((err) => {
          console.error(`[SMS Webhook - User #${userId}] Shopify update crash for order ${orderId}:`, err);
        });

      return res.status(200).json({
        success: true,
        reconciled: true,
        orderId: orderId,
        amount: amount,
        utr: utr
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[SMS Webhook - User #${userId}] Database error during webhook:`, error);
      return res.status(500).json({ error: 'Database transaction failed during webhook.' });
    } finally {
      client.release();
    }
  });

  // ==========================================
  // POST /api/pay/shopify-webhook/:userId
  // Receives webhooks from Shopify (e.g. orders/cancelled) to sync manual cancellations per user
  // ==========================================
  router.post('/shopify-webhook/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const signature = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_API_SECRET;

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid or missing user ID in URL path.' });
    }

    console.log(`[Shopify Webhook - User #${userId}] Ingesting webhook request...`);

    // Verify HMAC signature if SHOPIFY_API_SECRET is defined
    if (secret) {
      if (!signature) {
        console.warn(`[Shopify Webhook - User #${userId}] Missing X-Shopify-Hmac-SHA256 signature header. Rejecting.`);
        return res.status(401).json({ error: 'Unauthorized. Signature missing.' });
      }
      
      const crypto = require('crypto');
      const calculatedHmac = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body), 'utf8')
        .digest('base64');

      if (calculatedHmac !== signature) {
        console.error(`[Shopify Webhook - User #${userId}] HMAC validation mismatch. Request payload untrusted.`);
        return res.status(401).json({ error: 'Unauthorized. Signature mismatch.' });
      }
    }

    // Extract order reference
    const rawOrderId = req.body.admin_graphql_api_id || req.body.id;
    if (!rawOrderId) {
      return res.status(400).json({ error: 'Missing Shopify Order identifier in webhook body.' });
    }

    const orderId = String(rawOrderId).replace('gid://shopify/Order/', '');
    console.log(`[Shopify Webhook - User #${userId}] Processing cancellation for order #${orderId}`);

    const client = await getDb().connect();
    try {
      await client.query('BEGIN');

      // Update log to cancelled if it was still pending for this user
      const query = `
        UPDATE transaction_logs
        SET status = 'CANCELLED'
        WHERE order_id = $1 AND user_id = $2 AND status = 'PENDING'
        RETURNING order_id;
      `;
      const dbRes = await client.query(query, [orderId, userId]);
      await client.query('COMMIT');

      if (dbRes.rows.length > 0) {
        console.log(`[Shopify Webhook - User #${userId}] Pending transaction for order #${orderId} set to CANCELLED.`);
      } else {
        console.log(`[Shopify Webhook - User #${userId}] No matching active pending transaction found for order #${orderId}.`);
      }

      return res.status(200).json({ success: true, processed: true });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[Shopify Webhook - User #${userId}] Error updating transaction state:`, error);
      return res.status(500).json({ error: 'Database transaction failed during Shopify webhook sync.' });
    } finally {
      client.release();
    }
  });

  // GET /api/pay/details/:orderId - Returns transaction data for Hosted Checkout
  router.get('/details/:orderId', async (req, res) => {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId parameter.' });
    }

    try {
      const query = `
        SELECT t.order_id, t.base_amount, t.final_amount, t.status, t.expires_at, t.assigned_upi, 
               u.business_name, u.logo_url, u.checkout_primary_color, u.checkout_bg_color,
               u.checkout_timer_minutes, u.checkout_layout,
               p.account_holder
        FROM transaction_logs t
        JOIN users u ON t.user_id = u.id
        JOIN personal_upi_pool p ON t.assigned_upi = p.upi_id
        WHERE t.order_id = $1
      `;
      const dbRes = await getDb().query(query, [orderId]);
      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction details not found.' });
      }

      const txn = dbRes.rows[0];
      const upiUri = `upi://pay?pa=${encodeURIComponent(txn.assigned_upi)}&pn=${encodeURIComponent(txn.account_holder)}&am=${parseFloat(txn.final_amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(txn.order_id)}`;

      return res.status(200).json({
        success: true,
        orderId: txn.order_id,
        baseAmount: parseFloat(txn.base_amount),
        finalAmount: parseFloat(txn.final_amount),
        status: txn.status,
        expiresAt: txn.expires_at,
        assignedUpi: txn.assigned_upi,
        upiString: upiUri,
        businessName: txn.business_name,
        logoUrl: txn.logo_url,
        primaryColor: txn.checkout_primary_color,
        bgColor: txn.checkout_bg_color,
        checkoutTimerMinutes: parseInt(txn.checkout_timer_minutes || 7),
        checkoutLayout: txn.checkout_layout || 'glassmorphism'
      });
    } catch (error) {
      console.error('[Payment Router] Error fetching checkout details:', error);
      return res.status(500).json({ error: 'Database query failed.' });
    }
  });

  // POST /api/pay/submit-utr - Allows customer to submit UTR reference number
  router.post('/submit-utr', async (req, res) => {
    const { orderId, utrNumber } = req.body;

    if (!orderId || !utrNumber) {
      return res.status(400).json({ error: 'Missing required parameters: orderId and utrNumber.' });
    }

    if (!/^[A-Za-z0-9]{12,22}$/.test(utrNumber)) {
      return res.status(400).json({ error: 'Invalid UTR format. Must be 12-22 alphanumeric characters.' });
    }

    try {
      const query = `
        UPDATE transaction_logs
        SET utr_number = $1
        WHERE order_id = $2 AND status = 'PENDING'
        RETURNING order_id;
      `;
      const dbRes = await getDb().query(query, [utrNumber, orderId]);
      
      if (dbRes.rows.length === 0) {
        // Check if it's already approved
        const approvedCheck = await getDb().query(
          'SELECT order_id FROM transaction_logs WHERE order_id = $1 AND status = \'APPROVED\'',
          [orderId]
        );
        if (approvedCheck.rows.length > 0) {
          return res.status(200).json({ 
            success: true, 
            status: 'APPROVED', 
            message: 'Transaction is already paid and completed!' 
          });
        }
        
        return res.status(404).json({ error: 'Active pending transaction not found or already closed.' });
      }

      console.log(`[UTR Submission] Saved UTR ${utrNumber} for order #${orderId}.`);
      return res.status(200).json({ 
        success: true, 
        status: 'PENDING', 
        message: 'UTR submitted successfully. Awaiting SMS reconciliation.' 
      });
    } catch (error) {
      console.error('[Payment Router] UTR submission error:', error);
      return res.status(500).json({ error: 'Database transaction update failed.' });
    }
  });

  return router;
}

module.exports = {
  createPaymentRouter
};
