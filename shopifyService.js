/**
 * shopifyService.js
 * Service to handle communication with Shopify Admin GraphQL API (version 2026-07).
 * Handles marking orders as paid and canceling orders, supporting tenant-specific credentials.
 */

const dotenv = require('dotenv');
dotenv.config();

const GLOBAL_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const GLOBAL_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

/**
 * Normalizes an order ID to a Shopify GID format (gid://shopify/Order/12345)
 * @param {string|number} orderId Raw order ID
 * @returns {string} Normalized GID
 */
function normalizeOrderId(orderId) {
  const strId = String(orderId);
  if (strId.startsWith('gid://shopify/Order/')) {
    return strId;
  }
  const match = strId.match(/\b\d+\b/);
  const idNum = match ? match[0] : strId;
  return `gid://shopify/Order/${idNum}`;
}

/**
 * Sends a GraphQL query/mutation to the Shopify Admin API
 * @param {string} query GraphQL document
 * @param {object} variables Variables dictionary
 * @param {string} customStore Tenant specific store domain
 * @param {string} customToken Tenant specific admin access token
 * @returns {Promise<object>} Response data
 */
async function callShopifyGraphQL(query, variables = {}, customStore = null, customToken = null) {
  const domain = customStore || GLOBAL_STORE_DOMAIN;
  const token = customToken || GLOBAL_ACCESS_TOKEN;

  if (!domain || !token) {
    console.warn('[Shopify Service] Warning: Shopify credentials missing. Simulating API call.');
    return { mock: true, success: true };
  }

  const url = `https://${domain}/admin/api/2026-07/graphql.json`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Shopify API responded with status ${response.status}: ${errText}`);
    }

    const json = await response.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Shopify GraphQL Errors: ${JSON.stringify(json.errors)}`);
    }

    return json.data;
  } catch (error) {
    console.error(`[Shopify Service] Fetch Error for store ${domain}:`, error);
    throw error;
  }
}

/**
 * Marks a Shopify Order as Paid
 * @param {string|number} orderId The ID of the order to mark as paid
 * @param {string} customStore Tenant specific store domain
 * @param {string} customToken Tenant specific admin access token
 * @returns {Promise<boolean>} Resolves to true on success
 */
async function orderMarkAsPaid(orderId, customStore = null, customToken = null) {
  const gid = normalizeOrderId(orderId);
  console.log(`[Shopify Service] Marking order ${gid} as PAID on store ${customStore || 'global'}...`);

  const mutation = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order {
          id
          displayFinancialStatus
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: { id: gid }
  };

  try {
    const data = await callShopifyGraphQL(mutation, variables, customStore, customToken);
    if (data.mock) return true;

    const result = data.orderMarkAsPaid;
    if (result && result.userErrors && result.userErrors.length > 0) {
      console.error(`[Shopify Service] User errors marking order as paid:`, result.userErrors);
      return false;
    }

    console.log(`[Shopify Service] Order ${gid} successfully marked as PAID. Status: ${result.order.displayFinancialStatus}`);
    return true;
  } catch (error) {
    console.error(`[Shopify Service] Failed to mark order ${gid} as paid:`, error);
    return false;
  }
}

/**
 * Cancels an order in Shopify
 * @param {string|number} orderId The ID of the order to cancel
 * @param {string} reasonNote Custom cancellation note (e.g. customer_blew_past_payment_window)
 * @param {string} customStore Tenant specific store domain
 * @param {string} customToken Tenant specific admin access token
 * @returns {Promise<boolean>} Resolves to true on success
 */
async function orderCancel(orderId, reasonNote = 'customer_blew_past_payment_window', customStore = null, customToken = null) {
  const gid = normalizeOrderId(orderId);
  console.log(`[Shopify Service] Canceling order ${gid} on store ${customStore || 'global'}. Reason: ${reasonNote}...`);

  const cancelMutation = `
    mutation orderCancel($id: ID!, $reason: OrderCancelReason!, $refund: Boolean) {
      orderCancel(id: $id, reason: $reason, refund: $refund) {
        order {
          id
          cancelReason
          cancelledAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateNoteMutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // 1. Cancel the order
    const cancelData = await callShopifyGraphQL(cancelMutation, {
      id: gid,
      reason: 'OTHER',
      refund: false
    }, customStore, customToken);

    if (cancelData.mock) return true;

    const cancelResult = cancelData.orderCancel;
    if (cancelResult && cancelResult.userErrors && cancelResult.userErrors.length > 0) {
      console.error(`[Shopify Service] User errors canceling order:`, cancelResult.userErrors);
      return false;
    }

    // 2. Append note to order explaining the exact reason
    await callShopifyGraphQL(updateNoteMutation, {
      input: {
        id: gid,
        note: `Order cancelled automatically: ${reasonNote}`
      }
    }, customStore, customToken);

    console.log(`[Shopify Service] Order ${gid} successfully CANCELLED.`);
    return true;
  } catch (error) {
    console.error(`[Shopify Service] Failed to cancel order ${gid}:`, error);
    return false;
  }
}

/**
 * Verifies that the Shopify API token and domain are correct by querying shop metadata
 * @param {string} customStore Tenant specific store domain
 * @param {string} customToken Tenant specific admin access token
 * @returns {Promise<{success: boolean, name?: string, domain?: string, error?: string}>}
 */
async function verifyShopifyConnection(customStore = null, customToken = null) {
  console.log(`[Shopify Service] Testing connection to Shopify API for store ${customStore}...`);
  const query = `
    query {
      shop {
        name
        myshopifyDomain
      }
    }
  `;

  try {
    const data = await callShopifyGraphQL(query, {}, customStore, customToken);
    if (data.mock) {
      return { success: true, name: 'Mock Shopify Store', domain: 'mock-store.myshopify.com' };
    }
    if (data && data.shop) {
      console.log(`[Shopify Service] Successfully connected to store: ${data.shop.name}`);
      return { success: true, name: data.shop.name, domain: data.shop.myshopifyDomain };
    }
    return { success: false, error: 'Empty response returned from Shopify.' };
  } catch (error) {
    console.error('[Shopify Service] Verification failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Registers a Shopify webhook topic pointing to the specified callback URL
 * @param {string} topic Shopify webhook topic (e.g. ORDERS_CANCELLED)
 * @param {string} callbackUrl Gateway callback endpoint URL
 * @param {string} customStore Tenant specific store domain
 * @param {string} customToken Tenant specific admin access token
 * @returns {Promise<{success: boolean, webhookId?: string, error?: string}>}
 */
async function registerShopifyWebhook(topic, callbackUrl, customStore = null, customToken = null) {
  console.log(`[Shopify Service] Registering webhook for topic ${topic} pointing to ${callbackUrl}...`);

  const mutation = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    topic: topic,
    webhookSubscription: {
      callbackUrl: callbackUrl,
      format: 'JSON'
    }
  };

  try {
    const data = await callShopifyGraphQL(mutation, variables, customStore, customToken);
    if (data.mock) {
      return { success: true, webhookId: 'gid://shopify/WebhookSubscription/mock-id' };
    }

    const result = data.webhookSubscriptionCreate;
    if (result && result.userErrors && result.userErrors.length > 0) {
      console.error(`[Shopify Service] Webhook registration errors:`, result.userErrors);
      return { success: false, error: result.userErrors.map(e => e.message).join(', ') };
    }

    const webhookId = result.webhookSubscription.id;
    console.log(`[Shopify Service] Webhook registered successfully. ID: ${webhookId}`);
    return { success: true, webhookId: webhookId };
  } catch (error) {
    console.error(`[Shopify Service] Webhook registration failed:`, error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  orderMarkAsPaid,
  orderCancel,
  verifyShopifyConnection,
  registerShopifyWebhook
};
