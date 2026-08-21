import assert from 'node:assert/strict';
import test from 'node:test';
import { describeConfig, loadConfig, DEFAULT_SAAS_RESOURCE_ID } from '../src/lib/config.js';
import {
  createInMemorySubscriptionStore,
  createSubscriptionStore,
  createTableSubscriptionStore,
  mergeRecords
} from '../src/lib/subscriptionStore.js';
import { TENANT_ID, TEST_SECRET } from './helpers.js';

/* ------------------------------------------------------------------- merge */

test('a first write records createdUtc', () => {
  const merged = mergeRecords(null, { subscriptionId: 's1', updatedUtc: '2026-08-21T10:00:00Z' });
  assert.equal(merged.createdUtc, '2026-08-21T10:00:00Z');
});

test('createdUtc survives later updates', () => {
  const first = mergeRecords(null, {
    subscriptionId: 's1',
    status: 'Subscribed',
    updatedUtc: '2026-08-21T10:00:00Z',
    lastEventUtc: '2026-08-21T10:00:00Z'
  });
  const second = mergeRecords(first, {
    subscriptionId: 's1',
    status: 'Unsubscribed',
    updatedUtc: '2026-08-21T11:00:00Z',
    lastEventUtc: '2026-08-21T11:00:00Z'
  });
  assert.equal(second.createdUtc, '2026-08-21T10:00:00Z');
  assert.equal(second.status, 'Unsubscribed');
});

test('a stale event does not roll state backwards', () => {
  const current = mergeRecords(null, {
    subscriptionId: 's1',
    status: 'Unsubscribed',
    updatedUtc: '2026-08-21T12:00:00Z',
    lastEventUtc: '2026-08-21T12:00:00Z'
  });
  const stale = mergeRecords(current, {
    subscriptionId: 's1',
    status: 'Subscribed',
    updatedUtc: '2026-08-21T09:00:00Z',
    lastEventUtc: '2026-08-21T09:00:00Z',
    lastOperationId: 'op-late'
  });
  assert.equal(stale.status, 'Unsubscribed');
  assert.equal(stale.lastOperationId, 'op-late', 'the late delivery is still recorded');
});

test('undefined fields do not erase existing values', () => {
  const current = mergeRecords(null, {
    subscriptionId: 's1',
    planId: 'plan-a',
    updatedUtc: '2026-08-21T10:00:00Z'
  });
  const next = mergeRecords(current, {
    subscriptionId: 's1',
    planId: undefined,
    status: 'Subscribed',
    updatedUtc: '2026-08-21T11:00:00Z'
  });
  assert.equal(next.planId, 'plan-a');
});

/* --------------------------------------------------------------- in-memory */

test('an operation can only be claimed once', async () => {
  const store = createInMemorySubscriptionStore();
  assert.equal(await store.tryClaimOperation('s1', 'op1'), true);
  assert.equal(await store.tryClaimOperation('s1', 'op1'), false);
  assert.equal(await store.tryClaimOperation('s1', 'op2'), true);
  assert.equal(await store.tryClaimOperation('s2', 'op1'), true);
});

/* ------------------------------------------------------------------- table */

function fakeTableClient({ entities = new Map(), createTableError = null } = {}) {
  const calls = [];
  return {
    calls,
    entities,
    async createTable() {
      calls.push(['createTable']);
      if (createTableError) throw createTableError;
    },
    async getEntity(partitionKey, rowKey) {
      const hit = entities.get(`${partitionKey}|${rowKey}`);
      if (!hit) {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      }
      return hit;
    },
    async createEntity(entity) {
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      if (entities.has(key)) {
        const err = new Error('exists');
        err.statusCode = 409;
        throw err;
      }
      entities.set(key, entity);
    },
    async upsertEntity(entity) {
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      entities.set(key, { ...(entities.get(key) || {}), ...entity });
    }
  };
}

test('an existing table is tolerated rather than treated as an error', async () => {
  const err = new Error('exists');
  err.statusCode = 409;
  const store = createTableSubscriptionStore({
    tableClient: fakeTableClient({ createTableError: err })
  });
  assert.equal(await store.getSubscription('missing'), null);
});

test('table storage round-trips a subscription', async () => {
  const store = createTableSubscriptionStore({ tableClient: fakeTableClient() });
  await store.saveSubscription({
    subscriptionId: 's1',
    planId: 'plan-a',
    status: 'Subscribed',
    updatedUtc: '2026-08-21T10:00:00Z'
  });
  const read = await store.getSubscription('s1');
  assert.equal(read.subscriptionId, 's1');
  assert.equal(read.planId, 'plan-a');
  assert.equal(read.status, 'Subscribed');
});

test('a duplicate operation claim is refused by the storage layer', async () => {
  const store = createTableSubscriptionStore({ tableClient: fakeTableClient() });
  assert.equal(await store.tryClaimOperation('s1', 'op1'), true);
  assert.equal(await store.tryClaimOperation('s1', 'op1'), false);
});

test('storage state is not held in the process', async () => {
  // The same underlying table seen through two store instances must agree,
  // which is what surviving a restart or a second Function instance means.
  const shared = fakeTableClient();
  const a = createTableSubscriptionStore({ tableClient: shared });
  const b = createTableSubscriptionStore({ tableClient: shared });

  await a.saveSubscription({ subscriptionId: 's1', status: 'Subscribed', updatedUtc: 'x' });
  assert.equal((await b.getSubscription('s1')).status, 'Subscribed');
  assert.equal(await b.tryClaimOperation('s1', 'op1'), true);
  assert.equal(await a.tryClaimOperation('s1', 'op1'), false);
});

test('the store refuses to start without a connection string', async () => {
  await assert.rejects(
    () => createSubscriptionStore({ storageConnection: '', tableName: 't' }),
    (e) => e.code === 'store_not_configured'
  );
});

/* ------------------------------------------------------------------ config */

test('missing required settings are reported by name', () => {
  const result = loadConfig({});
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), [
    'MARKETPLACE_FULFILLMENT_CLIENT_ID',
    'MARKETPLACE_FULFILLMENT_CLIENT_SECRET',
    'MARKETPLACE_STORAGE_CONNECTION',
    'MARKETPLACE_TENANT_ID'
  ]);
});

test('the SaaS resource ID and table name have working defaults', () => {
  const { config } = loadConfig({});
  assert.equal(config.saasResourceId, DEFAULT_SAAS_RESOURCE_ID);
  assert.equal(config.tableName, 'MarketplaceSubscriptions');
});

test('malformed identifiers are reported rather than used', () => {
  const result = loadConfig({
    MARKETPLACE_TENANT_ID: 'not-a-guid',
    MARKETPLACE_FULFILLMENT_CLIENT_ID: 'also-not',
    MARKETPLACE_FULFILLMENT_CLIENT_SECRET: 's',
    MARKETPLACE_STORAGE_CONNECTION: 'c'
  });
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('MARKETPLACE_TENANT_ID'));
  assert.ok(result.invalid.includes('MARKETPLACE_FULFILLMENT_CLIENT_ID'));
});

test('the config description never carries the secret', () => {
  const result = loadConfig({
    MARKETPLACE_TENANT_ID: TENANT_ID,
    MARKETPLACE_FULFILLMENT_CLIENT_ID: TENANT_ID,
    MARKETPLACE_FULFILLMENT_CLIENT_SECRET: TEST_SECRET,
    MARKETPLACE_STORAGE_CONNECTION: 'UseDevelopmentStorage=true'
  });
  const described = JSON.stringify(describeConfig(result));
  assert.ok(!described.includes(TEST_SECRET));
  assert.ok(described.includes('"secretPresent":true'));
});
