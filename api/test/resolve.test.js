import assert from 'node:assert/strict';
import test from 'node:test';
import { handleResolve } from '../src/lib/handlers.js';
import { MarketplaceError } from '../src/lib/logging.js';
import { createInMemorySubscriptionStore } from '../src/lib/subscriptionStore.js';
import {
  TEST_PURCHASE_TOKEN,
  TEST_SECRET,
  fakeClient,
  makeContext
} from './helpers.js';

function deps(overrides = {}) {
  return {
    client: overrides.client || fakeClient(),
    store: overrides.store || createInMemorySubscriptionStore(),
    context: overrides.context || makeContext()
  };
}

test('a missing purchase token is rejected', async () => {
  const d = deps();
  const res = await handleResolve({ rawBody: JSON.stringify({}), deps: d });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'purchase_token_missing');
});

test('an empty or non-string token is rejected', async () => {
  const d = deps();
  for (const token of ['', '   ', 42, null, {}]) {
    const res = await handleResolve({ rawBody: JSON.stringify({ token }), deps: d });
    assert.equal(res.status, 400, `token ${JSON.stringify(token)} should be rejected`);
  }
});

test('an unparseable body is rejected', async () => {
  const res = await handleResolve({ rawBody: '{not json', deps: deps() });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'body_invalid');
});

test('an absurdly long token is rejected before any upstream call', async () => {
  const client = fakeClient();
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: 'x'.repeat(9000) }),
    deps: deps({ client })
  });
  assert.equal(res.status, 400);
  assert.equal(client.calls.length, 0, 'must not call Microsoft with an oversized token');
});

test('a successful resolve maps and persists the subscription', async () => {
  const store = createInMemorySubscriptionStore();
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ store })
  });

  assert.equal(res.status, 200);
  const sub = res.body.subscription;
  assert.equal(sub.subscriptionId, 'sub-0001');
  assert.equal(sub.planId, 'property-podcast-standard');
  assert.equal(sub.offerId, 'property-podcast');
  assert.equal(sub.status, 'Subscribed');
  assert.equal(sub.active, true);
  assert.equal(sub.termUnit, 'P1Y');

  const persisted = await store.getSubscription('sub-0001');
  assert.equal(persisted.status, 'Subscribed');
  assert.equal(persisted.beneficiaryTenantId, 'bbbbbbbb-0000-0000-0000-000000000002');
  assert.ok(persisted.createdUtc, 'createdUtc is recorded on first write');
});

test('the response exposes no personal identifiers', async () => {
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps()
  });
  const serialised = JSON.stringify(res.body);
  for (const leak of ['buyer@contoso.com', 'puid', '1234567890', 'objectId']) {
    assert.ok(!serialised.includes(leak), `response must not contain ${leak}`);
  }
});

test('an authentication failure against Microsoft is reported as a gateway error', async () => {
  const client = fakeClient({
    async resolvePurchaseToken() {
      throw new MarketplaceError('token_rejected', { status: 401 });
    }
  });
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ client })
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'token_rejected');
});

test('an invalid or expired purchase token is reported as a client error', async () => {
  const client = fakeClient({
    async resolvePurchaseToken() {
      throw new MarketplaceError('purchase_token_invalid', { status: 400 });
    }
  });
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ client })
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'purchase_token_invalid');
});

test('a malformed Microsoft response is handled rather than persisted', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async resolvePurchaseToken() {
      return { unexpected: true };
    }
  });
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ client, store })
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'resolve_malformed');
  assert.deepEqual(store._dump().subscriptions, []);
});

test('a storage failure is reported as unavailable, not as success', async () => {
  const store = createInMemorySubscriptionStore();
  store.saveSubscription = async () => {
    throw new MarketplaceError('store_write_failed');
  };
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ store })
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'store_write_failed');
});

test('neither the purchase token nor the client secret reaches the logs', async () => {
  const context = makeContext();
  await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ context })
  });

  const failing = makeContext();
  const client = fakeClient({
    async resolvePurchaseToken() {
      // An upstream error whose message embeds both secrets, as a real
      // fetch/Entra error could.
      throw new Error(`failed for ${TEST_PURCHASE_TOKEN} using ${TEST_SECRET}`);
    }
  });
  const res = await handleResolve({
    rawBody: JSON.stringify({ token: TEST_PURCHASE_TOKEN }),
    deps: deps({ client, context: failing })
  });

  for (const ctx of [context, failing]) {
    assert.ok(!ctx.text().includes(TEST_PURCHASE_TOKEN), 'purchase token must not be logged');
    assert.ok(!ctx.text().includes(TEST_SECRET), 'client secret must not be logged');
  }
  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes(TEST_PURCHASE_TOKEN));
  assert.ok(!serialised.includes(TEST_SECRET));
});
