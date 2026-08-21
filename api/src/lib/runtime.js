/**
 * Builds and caches the per-process dependencies (config, fulfillment client,
 * store, webhook authenticator).
 *
 * Construction is lazy and cached: the Functions host reuses a process across
 * invocations, so the access token cache and the JWKS cache stay warm rather
 * than being rebuilt per request.
 */
import { describeConfig, loadConfig } from './config.js';
import { createFulfillmentClient } from './fulfillmentClient.js';
import { createSubscriptionStore } from './subscriptionStore.js';
import { createWebhookAuthenticator } from './webhookAuth.js';
import { MarketplaceError, safeLog } from './logging.js';

let cached = null;

export async function getRuntime(context) {
  if (cached) return cached;

  const result = loadConfig();
  if (!result.ok) {
    // Names only — never values, never the secret.
    safeLog(context, 'error', 'marketplace.config.incomplete', describeConfig(result));
    throw new MarketplaceError('not_configured');
  }

  const { config } = result;
  const client = createFulfillmentClient({ config });
  const store = await createSubscriptionStore(config);
  const authenticate = createWebhookAuthenticator({ config });

  cached = { config, client, store, authenticate };
  return cached;
}

/** Test seam. */
export function _resetRuntime() {
  cached = null;
}

/**
 * Converts the handler's {status, body} into an Azure Functions HTTP response.
 * Responses are always JSON and always carry no-store, since every one of them
 * describes subscription state.
 */
export function toHttpResponse({ status, body }) {
  return {
    status,
    jsonBody: body,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  };
}
