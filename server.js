/**
 * server.js
 * Entrypoint for multi-tenant custom P2P UPI Payment Routing Gateway.
 * Configures the Express app, establishes connection to PostgreSQL pool,
 * seeds default tenant user if empty, and starts the automation cron services.
 * Supports tenant config hot-reloading and isolated API settings.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const dotenv = require('dotenv');

const { createPaymentRouter } = require('./paymentRouter');
const { createPoolRouter } = require('./poolRouter');
const { createAuthRouter } = require('./authRouter');
const { createAdminRouter } = require('./adminRouter');
const { initCronJobs } = require('./cronServices');
const { authenticateToken } = require('./authMiddleware');
const { verifyShopifyConnection, registerShopifyWebhook } = require('./shopifyService');
const { readConfig, writeConfig } = require('./configManager');

// Load environment variables initially
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and parsing of JSON payloads
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve static dashboard assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Global Wrapper for active PG pool (supports dynamically swapping in routers)
const poolWrapper = { pool: null };

/**
 * Health check endpoint.
 */
app.get('/health', async (req, res) => {
  try {
    if (!poolWrapper.pool) {
      throw new Error('Database pool not instantiated.');
    }
    await poolWrapper.pool.query('SELECT 1');
    return res.status(200).json({ status: 'OK', database: 'CONNECTED' });
  } catch (error) {
    return res.status(500).json({ status: 'ERROR', database: 'DISCONNECTED', details: error.message });
  }
});

/**
 * Auto-seeds a default merchant account and UPI pool VPA if empty.
 * Eliminates gateway cold starts for developers.
 */
async function autoSeedMerchant() {
  if (!poolWrapper.pool) return;
  try {
    // 1. Check if any admin user exists
    const checkAdmin = await poolWrapper.pool.query("SELECT count(*) FROM users WHERE role = 'admin'");
    if (parseInt(checkAdmin.rows[0].count) === 0) {
      console.log('[Bootstrap] Seeding default admin user (admin@gateway.com / adminpassword)...');
      
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('adminpassword', salt);
      const apiKey = 'upi_live_admin_' + require('crypto').randomBytes(20).toString('hex');
      
      const insertAdmin = `
        INSERT INTO users (email, password_hash, role, api_key)
        VALUES ('admin@gateway.com', $1, 'admin', $2);
      `;
      await poolWrapper.pool.query(insertAdmin, [hash, apiKey]);
    }

    // 2. Check if users table is empty
    const checkUser = await poolWrapper.pool.query('SELECT count(*) FROM users');
    if (parseInt(checkUser.rows[0].count) === 0 || (parseInt(checkUser.rows[0].count) === 1 && parseInt(checkAdmin.rows[0].count) === 1)) {
      console.log('[Bootstrap] Seeding default merchant user (merchant@gateway.com / password123)...');
      
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('password123', salt);
      
      const apiKey = 'upi_live_' + require('crypto').randomBytes(24).toString('hex');
      const insertUser = `
        INSERT INTO users (email, password_hash, shopify_store, api_key, role)
        VALUES ('merchant@gateway.com', $1, 'merchant-store.myshopify.com', $2, 'merchant')
        RETURNING id;
      `;
      const userRes = await poolWrapper.pool.query(insertUser, [hash, apiKey]);
      const userId = userRes.rows[0].id;

      // Seed default UPI VPA associated with this user
      console.log('[Bootstrap] Seeding default UPI VPA for seeded merchant...');
      const insertUpi = `
        INSERT INTO personal_upi_pool (upi_id, user_id, account_holder, daily_amount_limit, daily_count_limit, current_amount, current_count, is_active)
        VALUES ('merchant.savings@sbi', $1, 'Shopify Merchant Savings', 100000.00, 20, 0.00, 0, TRUE);
      `;
      await poolWrapper.pool.query(insertUpi, [userId]);
    }
  } catch (error) {
    console.warn('[Bootstrap] Auto-seeding skipped. Schema missing or db offline. Error:', error.message);
  }
}

/**
 * Instantiates the active PostgreSQL client pool.
 */
async function initializeDbPool(databaseUrl) {
  if (poolWrapper.pool) {
    console.log('[Database] Shutting down active connection pool...');
    try {
      await poolWrapper.pool.end();
    } catch (e) {
      console.error('[Database] Error closing pool:', e);
    }
    poolWrapper.pool = null;
  }

  const dbConfig = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'upi_gateway',
        password: process.env.PGPASSWORD || 'postgres',
        port: parseInt(process.env.PGPORT || '5432'),
      };

  console.log('[Database] Initializing connection pool...');
  try {
    const newPool = new Pool(dbConfig);
    await newPool.query('SELECT 1');
    poolWrapper.pool = newPool;
    console.log('[Database] PostgreSQL connection pool verified.');

    // Auto-run base schema.sql if tables are missing (Render deployment helper)
    try {
      const fs = require('fs');
      const schemaPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await newPool.query(schemaSql);
        console.log('[Database] Base schema created/verified.');
      }
    } catch (schemaErr) {
      console.warn('[Database] Auto-schema load skipped or failed:', schemaErr.message);
    }

    // Upgrade users table to support user roles, styling designer configurations, and settlements
    await newPool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'merchant' NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_timer_minutes INTEGER DEFAULT 7 NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_layout VARCHAR(50) DEFAULT 'glassmorphism' NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settlement_bank VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settlement_account VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS settlement_ifsc VARCHAR(50);
    `);

    // Upgrade personal_upi_pool to support weights, automatic cooldown timers, and connection pings
    await newPool.query(`
      ALTER TABLE personal_upi_pool ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 1 NOT NULL;
      ALTER TABLE personal_upi_pool ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP WITH TIME ZONE;
      ALTER TABLE personal_upi_pool ADD COLUMN IF NOT EXISTS last_ping TIMESTAMP WITH TIME ZONE;
    `);

    // Create unmatched_payments table (Paise Refund Assistant)
    await newPool.query(`
      CREATE TABLE IF NOT EXISTS unmatched_payments (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount NUMERIC(10, 2) NOT NULL,
          utr_number VARCHAR(30) NOT NULL UNIQUE,
          sender VARCHAR(50),
          message TEXT,
          resolved BOOLEAN DEFAULT FALSE,
          resolved_order_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // Auto-create Webhook logs table if not exists
    await newPool.query(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          order_id VARCHAR(255) NOT NULL,
          url VARCHAR(1000) NOT NULL,
          event_type VARCHAR(50) NOT NULL,
          payload TEXT NOT NULL,
          response_code INTEGER,
          response_body TEXT,
          success BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);

    // Auto-create Admin Audit Log table if not exists
    await newPool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
          id SERIAL PRIMARY KEY,
          admin_user_id INTEGER REFERENCES users(id),
          action VARCHAR(50) NOT NULL,
          target_user_id INTEGER,
          details TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Run auto-seeding helper
    await autoSeedMerchant();

    // Start background cron automations (resets daily trackers & sweeps expiries)
    initCronJobs(poolWrapper.pool);
    return true;
  } catch (error) {
    console.error('[Database] Connection check failed:', error.message);
    return false;
  }
}

// Mask sensitive settings parameters
function maskShopifyToken(token) {
  if (!token) return '';
  if (token.length <= 12) return '******';
  return token.substring(0, 8) + '******' + token.substring(token.length - 4);
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 15) return '******';
  return key.substring(0, 9) + '******' + key.substring(key.length - 4);
}

// ==========================================
// CONFIGURATION API ENDPOINTS (MULTI-TENANT)
// ==========================================

// GET /api/config - Returns active configurations (masked) for authenticated merchant or DB status publicly
app.get('/api/config', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const isDbConnected = !!poolWrapper.pool;

  if (!token || !isDbConnected) {
    return res.status(200).json({
      databaseStatus: isDbConnected ? 'CONNECTED' : 'DISCONNECTED'
    });
  }

  try {
    const jwt = require('jsonwebtoken');
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'gateway_jwt_secret_token_default_key_12984');
    const userId = verified.id;

    const query = `SELECT shopify_store, shopify_token, gateway_url, business_name, logo_url, checkout_primary_color, checkout_bg_color, api_key, webhook_url, checkout_timer_minutes, checkout_layout, settlement_bank, settlement_account, settlement_ifsc FROM users WHERE id = $1`;
    const dbRes = await poolWrapper.pool.query(query, [userId]);
    
    if (dbRes.rows.length === 0) {
      return res.status(404).json({ error: 'User configurations not found.' });
    }

    const config = dbRes.rows[0];

    return res.status(200).json({
      dbUrl: 'Scoped to Central DB (Hidden)',
      shopifyStore: config.shopify_store || '',
      shopifyToken: config.shopify_token ? maskShopifyToken(config.shopify_token) : '',
      gatewayUrl: config.gateway_url || '',
      businessName: config.business_name || '',
      logoUrl: config.logo_url || '',
      primaryColor: config.checkout_primary_color || '#8a2be2',
      bgColor: config.checkout_bg_color || '#ffffff',
      apiKey: config.api_key || '',
      webhookUrl: config.webhook_url || '',
      checkoutTimerMinutes: config.checkout_timer_minutes || 7,
      checkoutLayout: config.checkout_layout || 'glassmorphism',
      settlementBank: config.settlement_bank || '',
      settlementAccount: config.settlement_account || '',
      settlementIfsc: config.settlement_ifsc || '',
      databaseStatus: 'CONNECTED',
      shopifyStatus: (config.shopify_store && config.shopify_token) ? 'CONFIGURED' : 'UNCONFIGURED'
    });
  } catch (error) {
    console.error('[Server Config] Error fetching user config:', error);
    return res.status(200).json({ databaseStatus: isDbConnected ? 'CONNECTED' : 'DISCONNECTED' });
  }
});

// POST /api/config - Updates configurations dynamically
app.post('/api/config', async (req, res) => {
  const isDbConnected = !!poolWrapper.pool;

  if (!isDbConnected) {
    // Dynamic database connection setup (publicly accessible when DB is disconnected)
    const { dbUrl } = req.body;
    if (!dbUrl) {
      return res.status(400).json({ error: 'dbUrl is required to initialize database connection.' });
    }

    console.log('[Bootstrap] Dynamic database initialization requested by client wizard...');
    const success = await initializeDbPool(dbUrl.trim());
    if (success) {
      writeConfig({ DATABASE_URL: dbUrl.trim() });
      process.env.DATABASE_URL = dbUrl.trim();
      return res.status(200).json({
        success: true,
        message: 'Database connection established successfully!',
        databaseStatus: 'CONNECTED'
      });
    } else {
      return res.status(400).json({
        error: 'Failed to connect to the database with the provided URL. Please verify credentials.'
      });
    }
  }

  // If database is connected, configurations require JWT token
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Authorization token missing.' });
  }

  try {
    const jwt = require('jsonwebtoken');
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'gateway_jwt_secret_token_default_key_12984');
    const userId = verified.id;
    const { shopifyStore, shopifyToken, gatewayUrl, businessName, logoUrl, primaryColor, bgColor, webhookUrl, rotateApiKey, checkoutTimerMinutes, checkoutLayout, settlementBank, settlementAccount, settlementIfsc } = req.body;

    // Fetch current settings to check masking
    const selectQuery = `SELECT shopify_store, shopify_token, gateway_url, business_name, logo_url, checkout_primary_color, checkout_bg_color, api_key, webhook_url, checkout_timer_minutes, checkout_layout, settlement_bank, settlement_account, settlement_ifsc FROM users WHERE id = $1`;
    const checkRes = await poolWrapper.pool.query(selectQuery, [userId]);
    
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const current = checkRes.rows[0];
    
    // Normalize empty strings to null for Shopify integration to satisfy UNIQUE constraint in DB
    let updatedStore = current.shopify_store;
    if (shopifyStore !== undefined) {
      updatedStore = shopifyStore.trim() === '' ? null : shopifyStore.trim();
    }

    let updatedToken = current.shopify_token;
    if (shopifyToken !== undefined) {
      if (shopifyToken.trim() === '') {
        updatedToken = null;
      } else if (!shopifyToken.includes('******')) {
        updatedToken = shopifyToken.trim();
      }
    }

    const updatedGateway = gatewayUrl !== undefined ? gatewayUrl.trim() : current.gateway_url;
    const updatedBusinessName = businessName !== undefined ? businessName.trim() : (current.business_name || 'P2P Payments');
    const updatedLogoUrl = logoUrl !== undefined ? logoUrl.trim() : (current.logo_url || '');
    const updatedPrimaryColor = primaryColor !== undefined ? primaryColor.trim() : (current.checkout_primary_color || '#8a2be2');
    const updatedBgColor = bgColor !== undefined ? bgColor.trim() : (current.checkout_bg_color || '#ffffff');
    const updatedWebhookUrl = webhookUrl !== undefined ? webhookUrl.trim() : (current.webhook_url || '');
    const updatedTimerMinutes = checkoutTimerMinutes !== undefined ? Math.min(15, Math.max(3, parseInt(checkoutTimerMinutes) || 7)) : (current.checkout_timer_minutes || 7);
    const updatedLayout = checkoutLayout !== undefined ? checkoutLayout.trim() : (current.checkout_layout || 'glassmorphism');
    const updatedSettlementBank = settlementBank !== undefined ? settlementBank.trim() : (current.settlement_bank || '');
    const updatedSettlementAccount = settlementAccount !== undefined ? settlementAccount.trim() : (current.settlement_account || '');
    const updatedSettlementIfsc = settlementIfsc !== undefined ? settlementIfsc.trim() : (current.settlement_ifsc || '');

    let updatedApiKey = current.api_key;
    if (rotateApiKey === true || !current.api_key) {
      updatedApiKey = 'upi_live_' + require('crypto').randomBytes(24).toString('hex');
    }

    const updateQuery = `
      UPDATE users
      SET shopify_store = $1,
          shopify_token = $2,
          gateway_url = $3,
          business_name = $4,
          logo_url = $5,
          checkout_primary_color = $6,
          checkout_bg_color = $7,
          webhook_url = $8,
          api_key = $9,
          checkout_timer_minutes = $10,
          checkout_layout = $11,
          settlement_bank = $12,
          settlement_account = $13,
          settlement_ifsc = $14
      WHERE id = $15;
    `;
    await poolWrapper.pool.query(updateQuery, [
      updatedStore,
      updatedToken,
      updatedGateway,
      updatedBusinessName,
      updatedLogoUrl,
      updatedPrimaryColor,
      updatedBgColor,
      updatedWebhookUrl,
      updatedApiKey,
      updatedTimerMinutes,
      updatedLayout,
      updatedSettlementBank,
      updatedSettlementAccount,
      updatedSettlementIfsc,
      userId
    ]);

    return res.status(200).json({
      success: true,
      message: rotateApiKey ? 'API Key rotated successfully!' : 'Configurations saved successfully.',
      apiKey: rotateApiKey ? updatedApiKey : undefined,
      databaseStatus: 'CONNECTED',
      shopifyStatus: (updatedStore && updatedToken) ? 'CONFIGURED' : 'UNCONFIGURED'
    });

  } catch (error) {
    console.error('[Server Config] Error updating config:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This Shopify Store Domain is already registered by another merchant.' });
    }
    return res.status(500).json({ error: 'Database failed to update settings.' });
  }
});

// POST /api/shopify/auto-integrate - Auto-verifies connection and registers webhooks for merchant
app.post('/api/shopify/auto-integrate', authenticateToken, async (req, res) => {
  const { gatewayUrl } = req.body;
  const userId = req.user.id;

  if (!gatewayUrl) {
    return res.status(400).json({ error: 'Gateway public URL is required for webhook integration.' });
  }

  if (!gatewayUrl.startsWith('http://') && !gatewayUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Gateway public URL must start with http:// or https://' });
  }

  try {
    // 1. Fetch user's Shopify credentials
    const selectQuery = `SELECT shopify_store, shopify_token FROM users WHERE id = $1`;
    const userRes = await poolWrapper.pool.query(selectQuery, [userId]);
    const current = userRes.rows[0];
    
    if (!current.shopify_store || !current.shopify_token) {
      return res.status(400).json({ error: 'Please save your Shopify credentials before initiating auto-integration.' });
    }

    // 2. Save gateway URL to user's profile
    const updateQuery = `UPDATE users SET gateway_url = $1 WHERE id = $2`;
    await poolWrapper.pool.query(updateQuery, [gatewayUrl.trim(), userId]);

    // 3. Test Shopify Connection
    const verifyResult = await verifyShopifyConnection(current.shopify_store, current.shopify_token);
    if (!verifyResult.success) {
      return res.status(400).json({ 
        error: `Failed to connect to Shopify API: ${verifyResult.error}. Please verify store domain and access token.` 
      });
    }

    // 4. Formulate callback webhook URL isolated per user id
    const callbackUrl = `${gatewayUrl.replace(/\/$/, '')}/api/pay/shopify-webhook/${userId}`;
    
    // 5. Register Webhook for orders cancellation
    const webhookResult = await registerShopifyWebhook(
      'ORDERS_CANCELLED', 
      callbackUrl, 
      current.shopify_store, 
      current.shopify_token
    );
    
    if (!webhookResult.success) {
      return res.status(500).json({
        error: `Connected to Shopify as "${verifyResult.name}", but failed to register webhook: ${webhookResult.error}`
      });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully integrated with Shopify!`,
      shopName: verifyResult.name,
      shopDomain: verifyResult.domain,
      webhookId: webhookResult.webhookId
    });
  } catch (error) {
    console.error('[Server Config] Error during auto-integrate:', error);
    return res.status(500).json({ error: 'Internal server error during auto-integration.' });
  }
});


// Register main routers
const { createExternalRouter } = require('./externalRouter');
app.use('/api/auth', createAuthRouter(poolWrapper));
app.use('/api/admin', createAdminRouter(poolWrapper));
app.use('/api/pay', createPaymentRouter(poolWrapper));
app.use('/api/pool', createPoolRouter(poolWrapper));
app.use('/api/external', createExternalRouter(poolWrapper));

// Hosted Checkout Route
app.get('/checkout/:orderId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// Serve control dashboard routes
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Handle termination signals gracefully
process.on('SIGINT', async () => {
  console.log('[Shutdown] Closing database client pool...');
  if (poolWrapper.pool) {
    await poolWrapper.pool.end();
  }
  process.exit(0);
});

// Global bootstrap routine
async function bootstrap() {
  const current = readConfig();
  const dbUrl = current.DATABASE_URL || process.env.DATABASE_URL;

  console.log('[Bootstrap] Initializing gateway...');
  const success = await initializeDbPool(dbUrl);
  
  if (success) {
    console.log(`[Bootstrap] Gateway initialized in database-connected mode on port ${PORT}`);
  } else {
    console.log(`[Bootstrap] Gateway initialized in offline fallback mode on port ${PORT}. (Database disconnected)`);
  }

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[Server] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  });

  app.listen(PORT, () => {
    console.log(`[Bootstrap] Express Server listening on port ${PORT}`);
  });
}

bootstrap();
