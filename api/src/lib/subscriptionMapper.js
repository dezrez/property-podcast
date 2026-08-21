/**
 * Translates Microsoft's payloads into the minimum record we persist, and into
 * the even smaller projection the browser is allowed to see.
 *
 * Microsoft warns against strict deserialization ("Microsoft reserves the right
 * to expand the schema in future"), so every read here is defensive: unknown
 * fields are ignored, missing fields become undefined, and nothing throws on
 * shape alone.
 */

/** Statuses Microsoft documents for saasSubscriptionStatus. */
export const KNOWN_STATUSES = new Set([
  'PendingFulfillmentStart',
  'Subscribed',
  'Suspended',
  'Unsubscribed'
]);

/**
 * Actions that require an explicit acknowledgement via the Operations API.
 * Renew, Suspend and Unsubscribe are notify-only — acknowledging them is not
 * just unnecessary, the operation may not exist to patch.
 * https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-fulfillment-operations-api
 */
export const ACK_REQUIRED_ACTIONS = new Set(['ChangePlan', 'ChangeQuantity', 'Reinstate']);

/** Every action Microsoft currently documents for the webhook. */
export const KNOWN_ACTIONS = new Set([
  'Subscribe',
  'Unsubscribe',
  'ChangePlan',
  'ChangeQuantity',
  'Renew',
  'Suspend',
  'Reinstate'
]);

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value) {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Builds a record from a `subscription` object, which appears in the Resolve
 * response, the Get Subscription response and nested inside webhook payloads
 * with the same shape.
 */
export function mapSubscription(subscription, { source, nowIso = new Date().toISOString() } = {}) {
  if (!subscription || typeof subscription !== 'object') return null;

  const status = str(subscription.saasSubscriptionStatus);

  return {
    subscriptionId: str(subscription.id),
    subscriptionName: str(subscription.name),
    planId: str(subscription.planId),
    offerId: str(subscription.offerId),
    publisherId: str(subscription.publisherId),
    quantity: num(subscription.quantity),
    status: KNOWN_STATUSES.has(status) ? status : status,
    purchaserTenantId: str(subscription.purchaser && subscription.purchaser.tenantId),
    beneficiaryTenantId: str(subscription.beneficiary && subscription.beneficiary.tenantId),
    termUnit: str(subscription.term && subscription.term.termUnit),
    isFreeTrial: bool(subscription.isFreeTrial),
    isTest: bool(subscription.isTest),
    updatedUtc: nowIso,
    source
  };
}

/**
 * Resolve returns the identifiers at the top level and a fuller `subscription`
 * object nested inside. The nested object is preferred; the top level fills any
 * gaps.
 */
export function mapResolveResponse(payload, { nowIso = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const nested = mapSubscription(payload.subscription, { source: 'resolve', nowIso }) || {
    updatedUtc: nowIso,
    source: 'resolve'
  };

  return {
    ...nested,
    subscriptionId: nested.subscriptionId || str(payload.id),
    subscriptionName: nested.subscriptionName || str(payload.subscriptionName),
    planId: nested.planId || str(payload.planId),
    offerId: nested.offerId || str(payload.offerId),
    quantity: nested.quantity ?? num(payload.quantity)
  };
}

/**
 * Builds a record from a webhook payload. `authoritative` is the subscription
 * object re-read from Microsoft with our own credentials — when present its
 * status wins, because the webhook body is attacker-supplied until corroborated.
 */
export function mapWebhookEvent(event, authoritative, { nowIso = new Date().toISOString() } = {}) {
  const fromEvent = mapSubscription(event && event.subscription, { source: 'webhook', nowIso }) || {
    updatedUtc: nowIso,
    source: 'webhook'
  };
  const fromApi = authoritative
    ? mapSubscription(authoritative, { source: 'webhook', nowIso })
    : null;

  const base = fromApi ? { ...fromEvent, ...stripUndefined(fromApi) } : fromEvent;

  return {
    ...base,
    subscriptionId: base.subscriptionId || str(event && event.subscriptionId),
    planId: base.planId || str(event && event.planId),
    offerId: base.offerId || str(event && event.offerId),
    quantity: base.quantity ?? num(event && event.quantity),
    status: base.status || statusFromAction(str(event && event.action)),
    lastOperationId: str(event && event.id),
    lastOperationAction: str(event && event.action),
    lastEventUtc: str(event && event.timeStamp) || nowIso
  };
}

/**
 * Fallback only. Used when Microsoft's authoritative read is unavailable and
 * the payload carried no nested status.
 */
export function statusFromAction(action) {
  switch (action) {
    case 'Subscribe':
    case 'Renew':
    case 'ChangePlan':
    case 'ChangeQuantity':
    case 'Reinstate':
      return 'Subscribed';
    case 'Suspend':
      return 'Suspended';
    case 'Unsubscribe':
      return 'Unsubscribed';
    default:
      return undefined;
  }
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * What the browser is allowed to see. Deliberately excludes every personal
 * identifier Microsoft supplies — beneficiary/purchaser email, objectId and
 * puid — and never carries a token of any kind.
 */
export function toSafeProjection(record) {
  if (!record) return null;
  return {
    subscriptionId: record.subscriptionId,
    subscriptionName: record.subscriptionName,
    planId: record.planId,
    offerId: record.offerId,
    status: record.status,
    quantity: record.quantity,
    termUnit: record.termUnit,
    isFreeTrial: record.isFreeTrial ?? false,
    isTest: record.isTest ?? false,
    active: record.status === 'Subscribed',
    createdUtc: record.createdUtc,
    updatedUtc: record.updatedUtc
  };
}
