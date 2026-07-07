-- PostgreSQL Schema for Multi-Tenant P2P UPI Payment Routing Gateway

-- Table to track system users (merchants)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    shopify_store VARCHAR(255) UNIQUE, -- Shopify store domain (e.g., store.myshopify.com)
    shopify_token VARCHAR(255),        -- Shopify Admin Access Token
    gateway_url VARCHAR(255),          -- Gateway public URL for this user
    business_name VARCHAR(255) DEFAULT 'P2P Payments',
    logo_url TEXT DEFAULT '',
    checkout_primary_color VARCHAR(7) DEFAULT '#8a2be2',
    checkout_bg_color VARCHAR(7) DEFAULT '#ffffff',
    api_key VARCHAR(255) UNIQUE,
    webhook_url VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table to track personal UPI VPA accounts and their daily limits per user
CREATE TABLE IF NOT EXISTS personal_upi_pool (
    upi_id VARCHAR(255) PRIMARY KEY, -- VPA (globally unique, e.g., account@bank)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_holder VARCHAR(255) NOT NULL,
    daily_amount_limit NUMERIC(12, 2) DEFAULT 100000.00 NOT NULL,
    daily_count_limit INTEGER DEFAULT 20 NOT NULL,
    current_amount NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
    current_count INTEGER DEFAULT 0 NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL
);

-- Table to track transaction states and assignments per user
CREATE TABLE IF NOT EXISTS transaction_logs (
    order_id VARCHAR(255) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_amount NUMERIC(10, 2) NOT NULL,
    final_amount NUMERIC(10, 2) NOT NULL,
    assigned_upi VARCHAR(255) REFERENCES personal_upi_pool(upi_id) ON DELETE RESTRICT,
    status VARCHAR(20) DEFAULT 'PENDING' NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    cancel_at TIMESTAMP WITH TIME ZONE NOT NULL,
    utr_number VARCHAR(12) CHECK (utr_number IS NULL OR utr_number ~ '^\d{12}$'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Scoped unique index to guarantee that for any SINGLE user, no two PENDING transactions
-- share the same final_amount. This ensures reliable paise-level fingerprinting per merchant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_final_amount 
ON transaction_logs (user_id, final_amount) 
WHERE (status = 'PENDING');
