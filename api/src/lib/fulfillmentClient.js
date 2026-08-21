/**
 * MarketplaceFulfillmentClient — the only thing in this codebase that talks to
 * Microsoft's SaaS Fulfillment APIs.
 *
 * Authentication is the service-to-service client-credentials flow against the
 * Marketplace SaaS resource, exactly as documented:
 *   POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
 *   grant_type=client_credentials, scope={saasResourceId}/.default
 * https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-registration
 *
 * Microsoft is explicit that these APIs must only ever be called from a backend
 * service, never from the browser, so nothing in this file may be bundled into
 * frontend JavaScript.
 */
import { randomUUID } from 'node:crypto';
import {
  FULFILLMENT_API_VERSION,
  FULFILLMENT_BASE_URL
} from './config.js';
import { MarketplaceError } from './logging.js';

/** Refresh this far before real expiry so a token can't die mid-request. */
const EXPIRY_SKEW_SECONDS = 300;

export function createFulfillmentClient({
  config,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  baseUrl = FULFILLMENT_BASE_URL,
  apiVersion = FULFILLMENT_API_VERSION
}) {
  if (!config) throw new MarketplaceError('config_missing');

  // Cached token plus the in-flight promise, so a burst of webhook calls makes
  // one token request rather than one each.
  let cached = null;
  let inFlight = null;

  async function requestToken() {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.fulfillmentClientId,
      client_secret: config.fulfillmentClientSecret,
      scope: `${config.saasResourceId}/.default`
    });

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
    } catch (cause) {
      // Network-level failure. The cause may embed the request body, which
      // contains the client secret, so it is never surfaced or logged.
      throw new MarketplaceError('token_request_failed');
    }

    if (!res.ok) {
      // Deliberately does not include the provider response body: Entra error
      // payloads can echo request parameters.
      throw new MarketplaceError('token_rejected', { status: res.status });
    }

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new MarketplaceError('token_malformed');
    }

    const token = payload && payload.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new MarketplaceError('token_malformed');
    }

    const expiresIn = Number(payload.expires_in);
    const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    return {
      token,
      expiresAt: now() + Math.max(30, lifetime - EXPIRY_SKEW_SECONDS) * 1000
    };
  }

  async function getAccessToken() {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        cached = await requestToken();
        return cached.token;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function call(method, path, { body = undefined, extraHeaders = {} } = {}) {
    const token = await getAccessToken();
    const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`;

    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ms-requestid': randomUUID(),
      'x-ms-correlationid': randomUUID(),
      ...extraHeaders
    };

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new MarketplaceError('fulfillment_request_failed');
    }

    if (res.status === 401 || res.status === 403) {
      // The cached token may have been revoked; drop it so the next call
      // re-authenticates rather than repeating a rejected credential.
      cached = null;
      throw new MarketplaceError('fulfillment_unauthorized', { status: res.status });
    }

    return res;
  }

  async function readJson(res, errorCode) {
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new MarketplaceError(errorCode);
    }
    if (!payload || typeof payload !== 'object') {
      throw new MarketplaceError(errorCode);
    }
    return payload;
  }

  return {
    /** Exposed for diagnostics and tests; never returned over HTTP. */
    _getAccessToken: getAccessToken,

    /**
     * Exchanges a Marketplace purchase token for authoritative subscription
     * details.
     *
     * The token arrives on the landing page URL percent-encoded. Anything that
     * parses it with URLSearchParams (as marketplace.js does) has already
     * decoded it, so this method must not decode again — a second pass would
     * corrupt any token containing a literal '%' or '+'.
     */
    async resolvePurchaseToken(purchaseToken) {
      if (typeof purchaseToken !== 'string' || purchaseToken.trim().length === 0) {
        throw new MarketplaceError('purchase_token_missing');
      }

      const res = await call('POST', '/subscriptions/resolve', {
        extraHeaders: { 'x-ms-marketplace-token': purchaseToken }
      });

      if (res.status === 400) throw new MarketplaceError('purchase_token_invalid', { status: 400 });
      if (!res.ok) throw new MarketplaceError('resolve_failed', { status: res.status });

      const payload = await readJson(res, 'resolve_malformed');
      if (typeof payload.id !== 'string' || payload.id.length === 0) {
        throw new MarketplaceError('resolve_malformed');
      }
      return payload;
    },

    /** Authoritative read of a subscription's current state. */
    async getSubscription(subscriptionId) {
      requireId(subscriptionId);
      const res = await call('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      if (res.status === 404) throw new MarketplaceError('subscription_not_found', { status: 404 });
      if (!res.ok) throw new MarketplaceError('subscription_fetch_failed', { status: res.status });
      return readJson(res, 'subscription_malformed');
    },

    /**
     * Confirms an operation reported by a webhook actually exists on
     * Microsoft's side. Microsoft requires the webhook payload be validated
     * this way before acting on it.
     */
    async getOperation(subscriptionId, operationId) {
      requireId(subscriptionId);
      requireId(operationId, 'operation_id_invalid');
      const res = await call(
        'GET',
        `/subscriptions/${encodeURIComponent(subscriptionId)}/operations/${encodeURIComponent(operationId)}`
      );
      if (res.status === 404) throw new MarketplaceError('operation_not_found', { status: 404 });
      if (!res.ok) throw new MarketplaceError('operation_fetch_failed', { status: res.status });
      return readJson(res, 'operation_malformed');
    },

    /**
     * Acknowledges an operation. Only ChangePlan, ChangeQuantity and Reinstate
     * expect this; Renew, Suspend and Unsubscribe are notify-only.
     */
    async patchOperation(subscriptionId, operationId, status) {
      requireId(subscriptionId);
      requireId(operationId, 'operation_id_invalid');
      if (status !== 'Success' && status !== 'Failure') {
        throw new MarketplaceError('operation_status_invalid');
      }
      const res = await call(
        'PATCH',
        `/subscriptions/${encodeURIComponent(subscriptionId)}/operations/${encodeURIComponent(operationId)}`,
        { body: { status } }
      );
      if (!res.ok) throw new MarketplaceError('operation_patch_failed', { status: res.status });
      return true;
    }
  };
}

function requireId(value, code = 'subscription_id_invalid') {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new MarketplaceError(code);
  }
}
