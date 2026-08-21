import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketplaceError, redact, safeError, safeLog } from '../src/lib/logging.js';
import { TEST_SECRET } from './helpers.js';

/**
 * Stands in for Azure's InvocationContext, which is a real class whose log
 * methods read private fields. Calling such a method detached from its
 * instance throws "Cannot read private member…", so this reproduces the exact
 * shape that broke every configured webhook invocation.
 */
class FakeInvocationContext {
  #lines = [];

  log(message) {
    this.#lines.push(['log', message]);
  }

  warn(message) {
    this.#lines.push(['warn', message]);
  }

  error(message) {
    this.#lines.push(['error', message]);
  }

  get lines() {
    return this.#lines;
  }
}

test('the context logger is invoked as a method, not detached', () => {
  // A detached call throws TypeError against a class with private fields.
  // Because safeLog runs inside catch blocks, such a throw escapes and the
  // Functions host answers with an empty 500.
  const context = new FakeInvocationContext();
  assert.doesNotThrow(() => safeLog(context, 'error', 'test.message', { a: 1 }));
  assert.equal(context.lines.length, 1);
  assert.equal(context.lines[0][0], 'error');
  assert.match(context.lines[0][1], /test\.message/);
});

test('every log level reaches the context intact', () => {
  const context = new FakeInvocationContext();
  safeLog(context, 'log', 'a');
  safeLog(context, 'warn', 'b');
  safeLog(context, 'error', 'c');
  assert.deepEqual(
    context.lines.map((l) => l[0]),
    ['log', 'warn', 'error']
  );
});

test('a logging failure never propagates to the caller', () => {
  const exploding = {
    error() {
      throw new Error('log sink is down');
    }
  };
  assert.doesNotThrow(() => safeLog(exploding, 'error', 'test.message'));
});

test('an unserialisable field degrades instead of throwing', () => {
  const context = new FakeInvocationContext();
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => safeLog(context, 'log', 'test.message', circular));
  assert.equal(context.lines.length, 1);
});

test('a missing or malformed context is tolerated', () => {
  assert.doesNotThrow(() => safeLog(undefined, 'error', 'x'));
  assert.doesNotThrow(() => safeLog({}, 'error', 'x'));
  assert.doesNotThrow(() => safeLog({ error: 'not-a-function' }, 'error', 'x'));
});

test('forbidden fields are redacted at any depth', () => {
  const out = redact({
    ok: 'visible',
    authorization: 'Bearer abc',
    nested: { client_secret: TEST_SECRET, token: 'purchase', deeper: { password: 'p' } }
  });
  const text = JSON.stringify(out);
  assert.ok(text.includes('visible'));
  assert.ok(!text.includes('Bearer abc'));
  assert.ok(!text.includes(TEST_SECRET));
  assert.ok(!text.includes('purchase'));
  assert.ok(!text.includes('"p"'));
});

test('redaction survives arrays and deep nesting without exploding', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
  assert.doesNotThrow(() => redact(deep));
  assert.doesNotThrow(() => redact([{ token: 'x' }, { ok: 1 }]));
});

test('safeError never carries a message', () => {
  const err = new Error(`boom with ${TEST_SECRET}`);
  const out = JSON.stringify(safeError(err));
  assert.ok(!out.includes(TEST_SECRET));
  assert.equal(safeError(err).kind, 'Error');
  assert.equal(safeError(new MarketplaceError('token_rejected', { status: 401 })).kind, 'token_rejected');
  assert.equal(safeError(null).kind, 'unknown');
});
