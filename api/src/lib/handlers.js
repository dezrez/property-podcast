/**
 * Transport-independent handler logic.
 *
 * Kept free of Azure Functions types so it can be unit tested directly with
 * injected fakes and no live Marketplace calls. The function wrappers in
 * ../functions are thin adapters over these.
 */
import { MarketplaceError, safeError, safeLog } from './logging.js';
import {
  ACK_REQUIRED_ACTIONS,
  KNOWN_ACTIONS,
  mapResolveResponse,
  mapWebhookEvent,
  toSafeProjection
} from './subscriptionMapper.js';

/** Upper bound on an accepted purchase token, to bound parsing work. */
const MAX_TOKEN_LENGTH = 8192;

/**
 * Error code -> HTTP status. Anything unmapped becomes 500 so a new code can
 * never accidentally leak as a 200.
 */
const RESOLVE_STATUS = {
  purchase_token_missing: 400,
  purchase_token_invalid: 400,
  body_invalid: 400,
  // Our own credentials failed against Microsoft. That is our problem, not the
  // caller's, so it is reported as a bad gateway rather than a 401 that would
  // imply the buyer did something wrong.
  token_request_failed: 502,
  token_rejected: 502,
  token_malformed: 502,
  fulfillment_unauthorized: 502,
  fulfillment_request_failed: 502,
  resolve_failed: 502,
  resolve_malformed: 502,
  store_not_configured: 503,
  store_unavailable: 503,
  store_read_failed: 503,
  store_write_failed: 503,
  not_configured: 503
};

/* ------------------------------------------------------------ POST resolve */

/**
 * Exchanges a Marketplace purchase token for subscription details.
 *
 * Note on auto activation: this offer's plan has auto activation enabled, so
 * Microsoft activates at purchase and this endpoint deliberately does NOT call
 * the Activate API. Microsoft's documentation is explicit that with auto
 * activation the Activate call is not required, and calling it would be a
 * redundant state change against a subscription that is already Subscribed.
 * https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-fulfillment-life-cycle
 *
 * Resolve remains implemented because Microsoft still calls the landing page
 * with a token when a customer selects "Manage SaaS experience" on an active
 * subscription.
 */
export async function handleResolve({ rawBody, deps }) {
  const { client, store, context } = deps;

  let body;
  try {
    body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    return json(400, { error: 'body_invalid' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'body_invalid' });

  const token = body.token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    return json(400, { error: 'purchase_token_missing' });
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return json(400, { error: 'purchase_token_invalid' });
  }

  try {
    const payload = await client.resolvePurchaseToken(token);
    const record = mapResolveResponse(payload);

    if (!record || !record.subscriptionId) {
      throw new MarketplaceError('resolve_malformed');
    }

    const saved = await store.saveSubscription(record);

    safeLog(context, 'log', 'marketplace.resolve.succeeded', {
      subscriptionId: saved.subscriptionId,
      planId: saved.planId,
      status: saved.status
    });

    return json(200, { subscription: toSafeProjection(saved) });
  } catch (err) {
    const code = err instanceof MarketplaceError ? err.code : 'resolve_failed';
    const status = RESOLVE_STATUS[code] || 500;
    safeLog(context, 'error', 'marketplace.resolve.failed', safeError(err));
    return json(status, { error: code });
  }
}

/* ------------------------------------------------------------ POST webhook */

/**
 * Receives Marketplace lifecycle notifications.
 *
 * Order matters here. The operation is corroborated with Microsoft *before* the
 * idempotency marker is claimed, so that a transient upstream failure returns
 * 500 and Microsoft's retry is genuinely reprocessed rather than being
 * discarded as a duplicate.
 */
export async function handleWebhook({ authorizationHeader, rawBody, deps }) {
  const { authenticate, client, store, context } = deps;

  // 1. Authenticate. A validated Entra token is the only thing that makes the
  //    body trustworthy enough to parse.
  try {
    await authenticate(authorizationHeader);
  } catch (err) {
    const code = err instanceof MarketplaceError ? err.code : 'auth_token_invalid';
    safeLog(context, 'warn', 'marketplace.webhook.rejected', { reason: code });
    return json(401, { error: code });
  }

  // 2. Parse defensively. Microsoft reserves the right to extend this schema,
  //    so only the fields we act on are required.
  let event;
  try {
    event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    return json(400, { error: 'body_invalid' });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return json(400, { error: 'body_invalid' });
  }

  const action = typeof event.action === 'string' ? event.action : '';
  const subscriptionId = typeof event.subscriptionId === 'string' ? event.subscriptionId : '';
  const operationId = typeof event.id === 'string' ? event.id : '';

  if (!action || !subscriptionId || !operationId) {
    return json(400, { error: 'payload_invalid' });
  }

  // 3. An action we do not know about is acknowledged, not failed. Returning
  //    non-200 would make Microsoft retry it 500 times over eight hours for
  //    something we are never going to understand.
  if (!KNOWN_ACTIONS.has(action)) {
    safeLog(context, 'warn', 'marketplace.webhook.unknownAction', { action, subscriptionId });
    return json(200, { status: 'ignored', reason: 'unknown_action' });
  }

  try {
    // 4. Corroborate with Microsoft using our own credentials. The webhook body
    //    is never trusted on its own.
    //
    //    Microsoft's webhook doc says to validate via the Get Operation API,
    //    but the Operations API documents operations only for ChangePlan,
    //    ChangeQuantity, Reinstate and Unsubscribe — a Subscribe notification
    //    has no operation to fetch. Get Subscription is therefore used as the
    //    authoritative read for every action, and Get Operation additionally
    //    for the actions that have one.
    let operation = null;
    if (ACK_REQUIRED_ACTIONS.has(action)) {
      operation = await client.getOperation(subscriptionId, operationId);
      if (operation && typeof operation.action === 'string' && operation.action !== action) {
        safeLog(context, 'warn', 'marketplace.webhook.actionMismatch', {
          subscriptionId,
          claimed: action,
          actual: operation.action
        });
        return json(400, { error: 'operation_mismatch' });
      }
    }

    let authoritative = null;
    try {
      authoritative = await client.getSubscription(subscriptionId);
    } catch (err) {
      if (err instanceof MarketplaceError && err.code === 'subscription_not_found') {
        // Microsoft does not know this subscription. Retrying cannot fix that,
        // so acknowledge and record nothing.
        safeLog(context, 'warn', 'marketplace.webhook.subscriptionUnknown', { subscriptionId });
        return json(200, { status: 'ignored', reason: 'subscription_not_found' });
      }
      throw err;
    }

    // 5. Claim the operation. Losing this race means another delivery of the
    //    same notification already did the work.
    const claimed = await store.tryClaimOperation(subscriptionId, operationId);
    if (!claimed) {
      safeLog(context, 'log', 'marketplace.webhook.duplicate', { subscriptionId, action });
      return json(200, { status: 'duplicate' });
    }

    // 6. Persist.
    const record = mapWebhookEvent(event, authoritative);
    const saved = await store.saveSubscription(record);

    safeLog(context, 'log', 'marketplace.webhook.processed', {
      subscriptionId: saved.subscriptionId,
      action,
      status: saved.status
    });

    // 7. Acknowledge the operation where one exists. Microsoft auto-accepts
    //    after ten seconds, so a failure here is logged but not fatal.
    if (ACK_REQUIRED_ACTIONS.has(action)) {
      try {
        await client.patchOperation(subscriptionId, operationId, 'Success');
      } catch (err) {
        safeLog(context, 'error', 'marketplace.webhook.ackFailed', {
          subscriptionId,
          action,
          ...safeError(err)
        });
      }
    }

    return json(200, { status: 'accepted' });
  } catch (err) {
    // Upstream or storage failure: 500 invites Microsoft's retry, and the
    // operation was never claimed, so the retry is processed properly.
    safeLog(context, 'error', 'marketplace.webhook.failed', {
      subscriptionId,
      action,
      ...safeError(err)
    });
    return json(500, { error: 'processing_failed' });
  }
}

function json(status, body) {
  return { status, body };
}
