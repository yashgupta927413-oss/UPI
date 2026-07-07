const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Triggers a webhook callback event for a merchant user.
 * 
 * @param {number} userId - Merchant User ID.
 * @param {object} txn - Transaction object with properties order_id, base_amount, final_amount, assigned_upi, status, utr_number.
 * @param {import('pg').Pool} dbPool - Active database connection pool or client.
 */
async function triggerWebhook(userId, txn, dbPool) {
  try {
    const userRes = await dbPool.query('SELECT webhook_url FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return;
    const webhookUrl = userRes.rows[0].webhook_url;
    if (!webhookUrl) return;

    console.log(`[Webhook Dispatcher - User #${userId}] Dispatching event for order #${txn.order_id} to ${webhookUrl}...`);

    const parsedUrl = new URL(webhookUrl);
    const clientModule = parsedUrl.protocol === 'https:' ? https : http;
    const eventType = txn.status === 'APPROVED' ? 'payment.captured' : 'payment.failed';

    const payload = JSON.stringify({
      event: eventType,
      orderId: txn.order_id,
      baseAmount: parseFloat(txn.base_amount),
      finalAmount: parseFloat(txn.final_amount),
      assignedUpi: txn.assigned_upi,
      status: txn.status,
      utrNumber: txn.utr_number || null,
      timestamp: new Date().toISOString()
    });

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'UPI-Payment-Gateway/1.0 Webhook-Dispatcher'
      },
      timeout: 5000 // 5 seconds timeout limit
    };

    const result = await new Promise((resolve) => {
      const req = clientModule.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: responseData.substring(0, 1000), // Cap response snippet size
            success: res.statusCode >= 200 && res.statusCode < 300
          });
        });
      });

      req.on('error', (err) => {
        resolve({
          statusCode: null,
          body: `Error: ${err.message}`,
          success: false
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          statusCode: 408,
          body: 'Timeout: Webhook target took more than 5s to respond.',
          success: false
        });
      });

      req.write(payload);
      req.end();
    });

    console.log(`[Webhook Dispatcher - User #${userId}] Response Status: ${result.statusCode} for order #${txn.order_id}`);

    // Persist Webhook Delivery logs to postgresql table
    const insertLogQuery = `
      INSERT INTO webhook_delivery_logs (user_id, order_id, url, event_type, payload, response_code, response_body, success)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    await dbPool.query(insertLogQuery, [
      userId,
      txn.order_id,
      webhookUrl,
      eventType,
      payload,
      result.statusCode,
      result.body,
      result.success
    ]);

  } catch (err) {
    console.error(`[Webhook Dispatcher - User #${userId}] Error preparing webhook:`, err.message);
  }
}

module.exports = {
  triggerWebhook
};
