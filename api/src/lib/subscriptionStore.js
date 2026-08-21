/**
 * Durable storage for Marketplace subscription state.
 *
 * Azure Table Storage is the lightest durable option that fits a Static Web
 * Apps managed Functions app: managed functions get no managed identity and no
 * Key Vault references, and a full database would be far more than this needs.
 *
 * Two row kinds share one table, keyed by subscription:
 *   PartitionKey = subscriptionId, RowKey = 'subscription'  -> current state
 *   PartitionKey = subscriptionId, RowKey = 'op:<id>'       -> idempotency marker
 *
 * The operation marker is what makes webhook handling idempotent. Inserting it
 * is a conditional create: Table Storage rejects a duplicate with 409, so a
 * replayed notification is detected atomically rather than by a read-then-write
 * race.
 */
import { MarketplaceError } from './logging.js';

const SUBSCRIPTION_ROW = 'subscription';
const OPERATION_PREFIX = 'op:';

/* ------------------------------------------------------------------ table */

export function createTableSubscriptionStore({ tableClient }) {
  let ensured = null;

  async function ensureTable() {
    if (!ensured) {
      ensured = tableClient.createTable().catch((err) => {
        // 409 simply means it already exists.
        if (err && (err.statusCode === 409 || err.code === 'TableAlreadyExists')) return;
        ensured = null;
        throw new MarketplaceError('store_unavailable');
      });
    }
    return ensured;
  }

  return {
    async getSubscription(subscriptionId) {
      await ensureTable();
      try {
        const entity = await tableClient.getEntity(subscriptionId, SUBSCRIPTION_ROW);
        return fromEntity(entity);
      } catch (err) {
        if (err && err.statusCode === 404) return null;
        throw new MarketplaceError('store_read_failed');
      }
    },

    async saveSubscription(record) {
      await ensureTable();
      const existing = await this.getSubscription(record.subscriptionId);
      const merged = mergeRecords(existing, record);
      try {
        await tableClient.upsertEntity(
          { partitionKey: record.subscriptionId, rowKey: SUBSCRIPTION_ROW, ...toEntity(merged) },
          'Merge'
        );
      } catch {
        throw new MarketplaceError('store_write_failed');
      }
      return merged;
    },

    /**
     * Returns true if this operation has not been seen before, false if it is
     * a replay. The insert is the claim — there is no read-then-write gap.
     */
    async tryClaimOperation(subscriptionId, operationId) {
      await ensureTable();
      try {
        await tableClient.createEntity({
          partitionKey: subscriptionId,
          rowKey: OPERATION_PREFIX + operationId,
          claimedUtc: new Date().toISOString()
        });
        return true;
      } catch (err) {
        if (err && (err.statusCode === 409 || err.code === 'EntityAlreadyExists')) return false;
        throw new MarketplaceError('store_write_failed');
      }
    }
  };
}

/* -------------------------------------------------------------- in-memory */

/**
 * Test-only store. Never selected in Azure: `createSubscriptionStore` requires
 * a connection string and fails loudly without one, so a misconfigured
 * deployment cannot silently keep state in memory.
 */
export function createInMemorySubscriptionStore() {
  const subscriptions = new Map();
  const operations = new Set();

  return {
    async getSubscription(subscriptionId) {
      return subscriptions.get(subscriptionId) || null;
    },
    async saveSubscription(record) {
      const merged = mergeRecords(subscriptions.get(record.subscriptionId) || null, record);
      subscriptions.set(record.subscriptionId, merged);
      return merged;
    },
    async tryClaimOperation(subscriptionId, operationId) {
      const key = `${subscriptionId}|${operationId}`;
      if (operations.has(key)) return false;
      operations.add(key);
      return true;
    },
    /** Test helper. */
    _dump: () => ({ subscriptions: [...subscriptions.values()], operations: [...operations] })
  };
}

/* ----------------------------------------------------------------- shared */

/**
 * Later state wins, but a stale event must never overwrite newer state — the
 * webhook has a 500-retry policy over eight hours, so out-of-order delivery is
 * expected rather than exceptional.
 */
export function mergeRecords(existing, incoming) {
  if (!existing) {
    return { ...incoming, createdUtc: incoming.createdUtc || incoming.updatedUtc };
  }

  const existingAt = Date.parse(existing.lastEventUtc || existing.updatedUtc || 0);
  const incomingAt = Date.parse(incoming.lastEventUtc || incoming.updatedUtc || 0);
  if (Number.isFinite(existingAt) && Number.isFinite(incomingAt) && incomingAt < existingAt) {
    // Stale delivery: keep current state, but record that we saw it.
    return { ...existing, lastOperationId: incoming.lastOperationId || existing.lastOperationId };
  }

  return {
    ...existing,
    ...stripUndefined(incoming),
    createdUtc: existing.createdUtc || incoming.createdUtc || incoming.updatedUtc
  };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function toEntity(record) {
  return stripUndefined({
    subscriptionId: record.subscriptionId,
    planId: record.planId,
    offerId: record.offerId,
    status: record.status,
    quantity: record.quantity,
    purchaserTenantId: record.purchaserTenantId,
    beneficiaryTenantId: record.beneficiaryTenantId,
    termUnit: record.termUnit,
    isFreeTrial: record.isFreeTrial,
    isTest: record.isTest,
    createdUtc: record.createdUtc,
    updatedUtc: record.updatedUtc,
    lastOperationId: record.lastOperationId,
    lastOperationAction: record.lastOperationAction,
    lastEventUtc: record.lastEventUtc,
    source: record.source
  });
}

function fromEntity(entity) {
  const { partitionKey, rowKey, etag, timestamp, ...rest } = entity;
  return { ...rest, subscriptionId: rest.subscriptionId || partitionKey };
}

/**
 * Builds the production store. Deliberately throws when storage is not
 * configured rather than degrading to memory — losing subscription state on a
 * deployment would be a billing-correctness bug, not an inconvenience.
 */
export async function createSubscriptionStore(config, { TableClientCtor } = {}) {
  if (!config.storageConnection) throw new MarketplaceError('store_not_configured');

  const { TableClient } = TableClientCtor
    ? { TableClient: TableClientCtor }
    : await import('@azure/data-tables');

  const tableClient = TableClient.fromConnectionString(
    config.storageConnection,
    config.tableName,
    { allowInsecureConnection: config.storageConnection.includes('UseDevelopmentStorage') }
  );
  return createTableSubscriptionStore({ tableClient });
}
