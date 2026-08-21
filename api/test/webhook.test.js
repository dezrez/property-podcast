import assert from 'node:assert/strict';
import test from 'node:test';
import { handleWebhook } from '../src/lib/handlers.js';
import { MarketplaceError } from '../src/lib/logging.js';
import { createInMemorySubscriptionStore } from '../src/lib/subscriptionStore.js';
import {
  TEST_SECRET,
  fakeClient,
  makeContext,
  subscriptionFixture,
  webhookEventFixture
} from './helpers.js';

/** Accepts anything — JWT validation itself is covered in webhookAuth.test.js. */
const allow = async () => ({ aud: 'ok' });
const deny = (code) => async () => {
  throw new MarketplaceError(code);
};

function deps(overrides = {}) {
  return {
    authenticate: overrides.authenticate || allow,
    client: overrides.client || fakeClient(),
    store: overrides.store || createInMemorySubscriptionStore(),
    context: overrides.context || makeContext()
  };
}

const post = (event, d) =>
  handleWebhook({
    authorizationHeader: 'Bearer token',
    rawBody: typeof event === 'string' ? event : JSON.stringify(event),
    deps: d
  });

/* ------------------------------------------------------------ authentication */

test('a missing Authorization header is rejected with 401', async () => {
  const res = await handleWebhook({
    authorizationHeader: undefined,
    rawBody: JSON.stringify(webhookEventFixture()),
    deps: deps({ authenticate: deny('auth_header_missing') })
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'auth_header_missing');
});

test('an invalid JWT is rejected with 401 and nothing is persisted', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient();
  const res = await post(
    webhookEventFixture(),
    deps({ authenticate: deny('auth_signature_invalid'), store, client })
  );
  assert.equal(res.status, 401);
  assert.deepEqual(store._dump().subscriptions, []);
  assert.equal(client.calls.length, 0, 'must not call Microsoft for an unauthenticated request');
});

test('an expired JWT is rejected with 401', async () => {
  const res = await post(
    webhookEventFixture(),
    deps({ authenticate: deny('auth_token_expired') })
  );
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'auth_token_expired');
});

test('a wrong-audience JWT is rejected with 401', async () => {
  const res = await post(
    webhookEventFixture(),
    deps({ authenticate: deny('auth_audience_invalid') })
  );
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'auth_audience_invalid');
});

/* ------------------------------------------------------------------ payloads */

test('an unparseable body is rejected cleanly', async () => {
  const res = await post('{not json', deps());
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'body_invalid');
});

test('a payload missing required fields is rejected', async () => {
  for (const event of [
    {},
    { action: 'Subscribe' },
    { action: 'Subscribe', subscriptionId: 'sub-0001' },
    { subscriptionId: 'sub-0001', id: 'op-1' },
    []
  ]) {
    const res = await post(event, deps());
    assert.equal(res.status, 400, `${JSON.stringify(event)} should be rejected`);
  }
});

test('an unknown future action is acknowledged, not failed', async () => {
  // Returning non-200 would make Microsoft retry 500 times over eight hours
  // for an event we will never understand.
  const store = createInMemorySubscriptionStore();
  const res = await post(
    webhookEventFixture({ action: 'SomeFutureAction' }),
    deps({ store })
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, 'unknown_action');
  assert.deepEqual(store._dump().subscriptions, []);
});

test('unexpected extra fields do not break processing', async () => {
  // Microsoft reserves the right to expand the schema.
  const event = webhookEventFixture({ somethingNew: { nested: true }, anotherField: 42 });
  const res = await post(event, deps());
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');
});

/* --------------------------------------------------------------- lifecycle */

test('a valid Subscribe is accepted and persisted', async () => {
  const store = createInMemorySubscriptionStore();
  const res = await post(webhookEventFixture(), deps({ store }));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');

  const saved = await store.getSubscription('sub-0001');
  assert.equal(saved.status, 'Subscribed');
  assert.equal(saved.planId, 'property-podcast-standard');
  assert.equal(saved.lastOperationId, 'op-0001');
  assert.equal(saved.lastOperationAction, 'Subscribe');
  assert.ok(saved.createdUtc);
});

test('Subscribe does not acknowledge an operation', async () => {
  // Subscribe is notify-only; there is no operation to patch.
  const client = fakeClient();
  await post(webhookEventFixture(), deps({ client }));
  assert.ok(!client.calls.some((c) => c[0] === 'patchOperation'));
  assert.ok(!client.calls.some((c) => c[0] === 'getOperation'));
});

test('a repeated Subscribe is idempotent', async () => {
  const store = createInMemorySubscriptionStore();
  const d = deps({ store });
  const first = await post(webhookEventFixture(), d);
  const second = await post(webhookEventFixture(), d);

  assert.equal(first.body.status, 'accepted');
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'duplicate');
  assert.equal(store._dump().subscriptions.length, 1);
});

test('Unsubscribe moves the subscription to Unsubscribed', async () => {
  const store = createInMemorySubscriptionStore();
  await post(webhookEventFixture(), deps({ store }));

  const client = fakeClient({
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Unsubscribed' });
    }
  });
  const res = await post(
    webhookEventFixture({
      id: 'op-0002',
      action: 'Unsubscribe',
      timeStamp: '2026-08-21T11:00:00.0000000Z',
      subscription: subscriptionFixture({ saasSubscriptionStatus: 'Unsubscribed' })
    }),
    deps({ store, client })
  );

  assert.equal(res.status, 200);
  const saved = await store.getSubscription('sub-0001');
  assert.equal(saved.status, 'Unsubscribed');
  assert.equal(saved.lastOperationAction, 'Unsubscribe');
});

test('a repeated Unsubscribe remains idempotent', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Unsubscribed' });
    }
  });
  const d = deps({ store, client });
  const event = webhookEventFixture({ id: 'op-0002', action: 'Unsubscribe' });

  const first = await post(event, d);
  const second = await post(event, d);

  assert.equal(first.body.status, 'accepted');
  assert.equal(second.body.status, 'duplicate');
  const saved = await store.getSubscription('sub-0001');
  assert.equal(saved.status, 'Unsubscribed');
});

test('ChangePlan is corroborated and then acknowledged', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async getOperation(subscriptionId, operationId) {
      return { id: operationId, subscriptionId, action: 'ChangePlan', status: 'InProgress' };
    },
    async getSubscription() {
      return subscriptionFixture({ planId: 'plan-two' });
    }
  });

  const res = await post(
    webhookEventFixture({ id: 'op-0003', action: 'ChangePlan', planId: 'plan-two' }),
    deps({ store, client })
  );

  assert.equal(res.status, 200);
  const patched = client.calls.find((c) => c[0] === 'patchOperation');
  assert.ok(patched, 'ChangePlan must be acknowledged via the Operations API');
  assert.equal(patched[3], 'Success');
  const saved = await store.getSubscription('sub-0001');
  assert.equal(saved.planId, 'plan-two');
});

test('an operation whose action disagrees with the payload is refused', async () => {
  // Guards against a replayed or tampered body naming a different action than
  // the operation Microsoft actually has.
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async getOperation(subscriptionId, operationId) {
      return { id: operationId, subscriptionId, action: 'ChangeQuantity' };
    }
  });
  const res = await post(
    webhookEventFixture({ id: 'op-0004', action: 'ChangePlan' }),
    deps({ store, client })
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'operation_mismatch');
  assert.deepEqual(store._dump().subscriptions, []);
});

test('a failed acknowledgement still returns 200 because Microsoft auto-accepts', async () => {
  const client = fakeClient({
    async patchOperation() {
      throw new MarketplaceError('operation_patch_failed', { status: 500 });
    }
  });
  const res = await post(
    webhookEventFixture({ id: 'op-0005', action: 'ChangePlan' }),
    deps({ client })
  );
  assert.equal(res.status, 200);
});

test('Suspend and Reinstate are handled', async () => {
  const store = createInMemorySubscriptionStore();

  const suspendClient = fakeClient({
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Suspended' });
    }
  });
  await post(
    webhookEventFixture({ id: 'op-s1', action: 'Suspend' }),
    deps({ store, client: suspendClient })
  );
  assert.equal((await store.getSubscription('sub-0001')).status, 'Suspended');

  const reinstateClient = fakeClient({
    async getOperation(subscriptionId, operationId) {
      return { id: operationId, subscriptionId, action: 'Reinstate' };
    },
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Subscribed' });
    }
  });
  await post(
    webhookEventFixture({
      id: 'op-r1',
      action: 'Reinstate',
      timeStamp: '2026-08-21T12:00:00.0000000Z'
    }),
    deps({ store, client: reinstateClient })
  );
  assert.equal((await store.getSubscription('sub-0001')).status, 'Subscribed');
});

/* ------------------------------------------------------- trust and failures */

test('the webhook body is not trusted over Microsoft authoritative state', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Unsubscribed', planId: 'real-plan' });
    }
  });
  // A body claiming an active premium subscription...
  await post(
    webhookEventFixture({
      subscription: subscriptionFixture({
        saasSubscriptionStatus: 'Subscribed',
        planId: 'forged-premium-plan'
      })
    }),
    deps({ store, client })
  );
  // ...loses to what Microsoft actually says.
  const saved = await store.getSubscription('sub-0001');
  assert.equal(saved.status, 'Unsubscribed');
  assert.equal(saved.planId, 'real-plan');
});

test('an event for a subscription Microsoft does not know is acknowledged but not stored', async () => {
  const store = createInMemorySubscriptionStore();
  const client = fakeClient({
    async getSubscription() {
      throw new MarketplaceError('subscription_not_found', { status: 404 });
    }
  });
  const res = await post(webhookEventFixture(), deps({ store, client }));
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, 'subscription_not_found');
  assert.deepEqual(store._dump().subscriptions, []);
});

test('an upstream failure returns 500 and leaves the event replayable', async () => {
  const store = createInMemorySubscriptionStore();
  let attempt = 0;
  const client = fakeClient({
    async getSubscription() {
      attempt += 1;
      if (attempt === 1) throw new MarketplaceError('fulfillment_request_failed');
      return subscriptionFixture();
    }
  });
  const d = deps({ store, client });

  const first = await post(webhookEventFixture(), d);
  assert.equal(first.status, 500, 'a transient failure must invite a retry');

  // Microsoft retries. Because the operation was never claimed, the retry is
  // processed properly rather than being discarded as a duplicate.
  const retry = await post(webhookEventFixture(), d);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, 'accepted');
  assert.equal((await store.getSubscription('sub-0001')).status, 'Subscribed');
});

test('a stale delivery does not overwrite newer state', async () => {
  const store = createInMemorySubscriptionStore();

  const unsubClient = fakeClient({
    async getSubscription() {
      return subscriptionFixture({ saasSubscriptionStatus: 'Unsubscribed' });
    }
  });
  await post(
    webhookEventFixture({
      id: 'op-new',
      action: 'Unsubscribe',
      timeStamp: '2026-08-21T12:00:00.0000000Z'
    }),
    deps({ store, client: unsubClient })
  );

  // An older Subscribe arrives late.
  await post(
    webhookEventFixture({ id: 'op-old', timeStamp: '2026-08-21T09:00:00.0000000Z' }),
    deps({ store })
  );

  assert.equal((await store.getSubscription('sub-0001')).status, 'Unsubscribed');
});

test('no secret or token reaches the logs on any path', async () => {
  const context = makeContext();
  const client = fakeClient({
    async getSubscription() {
      throw new Error(`upstream blew up with ${TEST_SECRET}`);
    }
  });
  await post(webhookEventFixture(), deps({ client, context }));
  assert.ok(!context.text().includes(TEST_SECRET));
});
