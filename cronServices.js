/**
 * cronServices.js
 * Multi-tenant node-cron schedules.
 * Task A: Midnight reset of limits for all UPI VPAs.
 * Task B: Every-minute sweep of expired pending payments, cancelling them 
 *         and notifying the correct tenant's Shopify store using their database credentials.
 */

const cron = require('node-cron');
const { orderCancel } = require('./shopifyService');

/**
 * Initializes the background cron jobs.
 * @param {import('pg').Pool} dbPool PostgreSQL connection pool wrapper.
 */
function initCronJobs(dbPool) {
  let sweepRunning = false;

  const getDb = () => {
    const activeDb = (dbPool && dbPool.pool) ? dbPool.pool : dbPool;
    return activeDb;
  };

  // ==========================================
  // Task A: Midnight Reset
  // Resets limits on all pools globally
  // ==========================================
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron Service] Running Midnight reset for UPI pools...');
    const pool = getDb();
    if (!pool) {
      console.warn('[Cron Service] Skip reset: Database not connected.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = `UPDATE personal_upi_pool SET current_amount = 0.00, current_count = 0;`;
      const res = await client.query(query);
      await client.query('COMMIT');
      console.log(`[Cron Service] Midnight reset complete. Reset ${res.rowCount} accounts.`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Cron Service] Midnight reset failed:', error);
    } finally {
      if (client) client.release();
    }
  }, { timezone: 'Asia/Kolkata' });

  // ==========================================
  // Task B: Minute Expired Payment Sweeper
  // Sweeps PENDING transactions, cancels them on Shopify using user specific tokens
  // ==========================================
  cron.schedule('* * * * *', async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    console.log('[Cron Service] Sweeping for expired pending transactions...');
    const pool = getDb();
    if (!pool) {
      console.warn('[Cron Service] Skip sweep: Database not connected.');
      sweepRunning = false;
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update expired PENDING transaction statuses to CANCELLED
      const query = `
        UPDATE transaction_logs
        SET status = 'CANCELLED'
        WHERE status = 'PENDING' AND cancel_at <= NOW()
        RETURNING order_id, user_id, base_amount, final_amount, assigned_upi;
      `;
      const res = await client.query(query);
      await client.query('COMMIT');

      const expiredTxns = res.rows;
      if (expiredTxns.length > 0) {
        console.log(`[Cron Service] Found ${expiredTxns.length} expired transactions. Sweeping...`);
        
        // Loop through each expired transaction and trigger tenant-specific cancellations
        for (const txn of expiredTxns) {
          try {
            // Fetch the user's specific Shopify credentials from the database
            const userQuery = `SELECT shopify_store, shopify_token FROM users WHERE id = $1`;
            const userRes = await client.query(userQuery, [txn.user_id]);
            
            if (userRes.rows.length === 0) {
              console.error(`[Cron Sweep] Merchant ID #${txn.user_id} not found. Skipping order #${txn.order_id}`);
              continue;
            }

            const merchant = userRes.rows[0];

            // Check for consecutive failures on this specific VPA to activate cool-down
            if (txn.assigned_upi) {
              try {
                const checkFailures = `
                  SELECT status FROM transaction_logs
                  WHERE assigned_upi = $1
                  ORDER BY created_at DESC
                  LIMIT 5;
                `;
                const failRes = await client.query(checkFailures, [txn.assigned_upi]);
                const allFailed = failRes.rows.length === 5 && failRes.rows.every(r => r.status === 'CANCELLED');
                if (allFailed) {
                  console.warn(`[Cron Sweep] VPA ${txn.assigned_upi} has hit 5 consecutive timeout failures. Triggering 30 minutes cooldown.`);
                  const setCooldown = `
                    UPDATE personal_upi_pool
                    SET cooldown_until = NOW() + INTERVAL '30 minutes'
                    WHERE upi_id = $1;
                  `;
                  await client.query(setCooldown, [txn.assigned_upi]);
                }
              } catch (failErr) {
                console.error(`[Cron Sweep] Failed to evaluate VPA cooldown check:`, failErr.message);
              }
            }

            console.log(`[Cron Sweep] Cancelling order #${txn.order_id} for User #${txn.user_id} (Store: ${merchant.shopify_store || 'Unconfigured'})`);

            // Execute cancellation mutation asynchronously
            orderCancel(txn.order_id, 'customer_blew_past_payment_window', merchant.shopify_store, merchant.shopify_token)
              .then((success) => {
                if (success) {
                  console.log(`[Cron Sweep] Shopify order #${txn.order_id} cancelled successfully.`);
                } else {
                  console.error(`[Cron Sweep] Failed to cancel Shopify order #${txn.order_id}`);
                }
              })
              .catch((err) => {
                console.error(`[Cron Sweep] Error calling Shopify Cancel API for order #${txn.order_id}:`, err);
              });

            // Trigger webhook notification for manual API integrations
            try {
              const { triggerWebhook } = require('./webhookDispatcher');
              triggerWebhook(txn.user_id, {
                order_id: txn.order_id,
                base_amount: txn.base_amount,
                final_amount: txn.final_amount,
                assigned_upi: null,
                status: 'CANCELLED'
              }, pool);
            } catch (webhookErr) {
              console.error(`[Cron Sweep] Error dispatching webhook alert:`, webhookErr.message);
            }

          } catch (err) {
            console.error(`[Cron Sweep] Error processing cancellation for order #${txn.order_id}:`, err);
          }
        }
      } else {
        console.log('[Cron Service] Sweep complete. No expired transactions found.');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Cron Service] Transaction sweep failed:', error);
    } finally {
      if (client) client.release();
      sweepRunning = false;
    }
  });

  console.log('[Cron Service] Cron jobs initialized successfully.');
}

module.exports = {
  initCronJobs
};
