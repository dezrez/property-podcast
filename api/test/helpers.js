/**
 * Shared test fixtures. Every external Microsoft call is faked here — the
 * suite never touches a live Marketplace endpoint.
 */
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

export const TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const FULFILLMENT_CLIENT_ID = '22222222-2222-2222-2222-222222222222';
export const BUYER_CLIENT_ID = '33333333-3333-3333-3333-333333333333';
export const SAAS_RESOURCE_ID = '20e940b3-4c77-4b0b-9a53-9e16a1b010a7';

/** A value that must never appear in any log line or response body. */
export const TEST_SECRET = 'super-secret-client-value-do-not-log';
export const TEST_PURCHASE_TOKEN = 'purchase-token-must-never-be-logged';

export const TEST_CONFIG = {
  tenantId: TENANT_ID,
  fulfillmentClientId: FULFILLMENT_CLIENT_ID,
  fulfillmentClientSecret: TEST_SECRET,
  buyerClientId: BUYER_CLIENT_ID,
  saasResourceId: SAAS_RESOURCE_ID,
  storageConnection: 'UseDevelopmentStorage=true',
  tableName: 'TestSubscriptions'
};

const KID = 'test-signing-key';

export async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, keyStore: createLocalJWKSet({ keys: [jwk] }) };
}

/** Mints a token shaped like the one Microsoft sends to the webhook. */
export async function signWebhookToken(privateKey, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const {
    aud = FULFILLMENT_CLIENT_ID,
    iss = `https://sts.windows.net/${TENANT_ID}/`,
    tid = TENANT_ID,
    appid = SAAS_RESOURCE_ID,
    azp,
    iat = nowSec,
    exp = nowSec + 300,
    ...rest
  } = overrides;

  const claims = { aud, iss, tid, ...rest };
  if (appid !== undefined && appid !== null) claims.appid = appid;
  if (azp !== undefined && azp !== null) claims.azp = azp;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

/** Captures log output so tests can assert secrets never reach it. */
export function makeContext() {
  const lines = [];
  const at = (level) => (message) => lines.push({ level, message: String(message) });
  return {
    log: at('log'),
    warn: at('warn'),
    error: at('error'),
    lines,
    text: () => lines.map((l) => l.message).join('\n')
  };
}

/** A subscription object shaped like Microsoft's. */
export function subscriptionFixture(overrides = {}) {
  return {
    id: 'sub-0001',
    name: 'Property Podcast Standard',
    publisherId: 'dezrez',
    offerId: 'property-podcast',
    planId: 'property-podcast-standard',
    quantity: 1,
    beneficiary: {
      emailId: 'buyer@contoso.com',
      objectId: 'aaaaaaaa-0000-0000-0000-000000000001',
      tenantId: 'bbbbbbbb-0000-0000-0000-000000000002',
      puid: '1234567890'
    },
    purchaser: {
      emailId: 'buyer@contoso.com',
      objectId: 'aaaaaaaa-0000-0000-0000-000000000001',
      tenantId: 'bbbbbbbb-0000-0000-0000-000000000002',
      puid: '1234567890'
    },
    term: { termUnit: 'P1Y', startDate: '2026-08-01T00:00:00Z', endDate: '2027-07-31T00:00:00Z' },
    allowedCustomerOperations: ['Read', 'Update', 'Delete'],
    saasSubscriptionStatus: 'Subscribed',
    isFreeTrial: false,
    isTest: true,
    autoRenew: false,
    ...overrides
  };
}

/** A webhook event shaped like Microsoft's. */
export function webhookEventFixture(overrides = {}) {
  const subscription = overrides.subscription || subscriptionFixture();
  return {
    id: 'op-0001',
    activityId: 'act-0001',
    publisherId: 'dezrez',
    offerId: 'property-podcast',
    planId: 'property-podcast-standard',
    quantity: 1,
    subscriptionId: subscription.id,
    timeStamp: '2026-08-21T10:00:00.0000000Z',
    action: 'Subscribe',
    status: 'Succeeded',
    operationRequestSource: 'Azure',
    purchaseToken: null,
    ...overrides,
    subscription
  };
}

/**
 * A fake fulfillment client. Records calls and returns canned data; each
 * behaviour can be overridden per test.
 */
export function fakeClient(overrides = {}) {
  const calls = [];
  const base = {
    async resolvePurchaseToken(token) {
      calls.push(['resolve', token]);
      const subscription = subscriptionFixture();
      return {
        id: subscription.id,
        subscriptionName: subscription.name,
        offerId: subscription.offerId,
        planId: subscription.planId,
        quantity: subscription.quantity,
        subscription
      };
    },
    async getSubscription(id) {
      calls.push(['getSubscription', id]);
      return subscriptionFixture();
    },
    async getOperation(subscriptionId, operationId) {
      calls.push(['getOperation', subscriptionId, operationId]);
      return { id: operationId, subscriptionId, action: 'ChangePlan', status: 'InProgress' };
    },
    async patchOperation(subscriptionId, operationId, status) {
      calls.push(['patchOperation', subscriptionId, operationId, status]);
      return true;
    }
  };
  return { ...base, ...overrides, calls };
}
