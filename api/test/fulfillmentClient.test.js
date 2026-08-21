import assert from 'node:assert/strict';
import test from 'node:test';
import { FULFILLMENT_API_VERSION } from '../src/lib/config.js';
import { createFulfillmentClient } from '../src/lib/fulfillmentClient.js';
import { SAAS_RESOURCE_ID, TENANT_ID, TEST_CONFIG, TEST_SECRET, subscriptionFixture } from './helpers.js';

/** Builds a fetch stub that records requests and replays queued responses. */
function stubFetch(responders) {
  const requests = [];
  const impl = async (url, init = {}) => {
    requests.push({ url, init });
    for (const responder of responders) {
      const res = responder(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected request to ${url}`);
  };
  impl.requests = requests;
  return impl;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const tokenResponder = (token = 'access-token-1', expiresIn = 3600) => (url) =>
  url.includes('/oauth2/v2.0/token')
    ? jsonResponse(200, { access_token: token, expires_in: expiresIn, token_type: 'Bearer' })
    : null;

test('the access token is requested with the documented endpoint, grant and scope', async () => {
  const fetchImpl = stubFetch([tokenResponder()]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  const token = await client._getAccessToken();
  assert.equal(token, 'access-token-1');

  const { url, init } = fetchImpl.requests[0];
  assert.equal(url, `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');

  const body = new URLSearchParams(init.body);
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('scope'), `${SAAS_RESOURCE_ID}/.default`);
  assert.equal(body.get('client_id'), TEST_CONFIG.fulfillmentClientId);
});

test('the token is reused rather than re-requested for every call', async () => {
  let tokenRequests = 0;
  const fetchImpl = stubFetch([
    (url) => {
      if (!url.includes('/oauth2/v2.0/token')) return null;
      tokenRequests += 1;
      return jsonResponse(200, { access_token: 'cached', expires_in: 3600 });
    },
    (url) => (url.includes('/subscriptions/') ? jsonResponse(200, subscriptionFixture()) : null)
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  await client.getSubscription('sub-1');
  await client.getSubscription('sub-1');
  await client.getSubscription('sub-1');

  assert.equal(tokenRequests, 1, 'one token should serve many calls');
});

test('concurrent calls share a single token request', async () => {
  let tokenRequests = 0;
  const fetchImpl = stubFetch([
    (url) => {
      if (!url.includes('/oauth2/v2.0/token')) return null;
      tokenRequests += 1;
      return jsonResponse(200, { access_token: 'cached', expires_in: 3600 });
    },
    (url) => (url.includes('/subscriptions/') ? jsonResponse(200, subscriptionFixture()) : null)
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  await Promise.all([
    client.getSubscription('sub-1'),
    client.getSubscription('sub-2'),
    client.getSubscription('sub-3')
  ]);

  assert.equal(tokenRequests, 1);
});

test('an expired cached token is refreshed', async () => {
  let tokenRequests = 0;
  let clock = 1_000_000;
  const fetchImpl = stubFetch([
    (url) => {
      if (!url.includes('/oauth2/v2.0/token')) return null;
      tokenRequests += 1;
      return jsonResponse(200, { access_token: `t${tokenRequests}`, expires_in: 3600 });
    },
    (url) => (url.includes('/subscriptions/') ? jsonResponse(200, subscriptionFixture()) : null)
  ]);
  const client = createFulfillmentClient({
    config: TEST_CONFIG,
    fetchImpl,
    now: () => clock
  });

  await client.getSubscription('sub-1');
  clock += 3600 * 1000; // past expiry, including the safety skew
  await client.getSubscription('sub-1');

  assert.equal(tokenRequests, 2);
});

test('resolve sends the purchase token in the documented header and api-version', async () => {
  const fetchImpl = stubFetch([
    tokenResponder(),
    (url) =>
      url.includes('/subscriptions/resolve')
        ? jsonResponse(200, { id: 'sub-0001', subscription: subscriptionFixture() })
        : null
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  await client.resolvePurchaseToken('ab+cd/ef');

  const call = fetchImpl.requests.find((r) => r.url.includes('/subscriptions/resolve'));
  assert.ok(call.url.includes(`api-version=${FULFILLMENT_API_VERSION}`));
  assert.equal(call.init.method, 'POST');
  // The token must be forwarded exactly as received. URLSearchParams has
  // already decoded it on the page, so decoding again here would corrupt any
  // token containing a literal '+' or '%'.
  assert.equal(call.init.headers['x-ms-marketplace-token'], 'ab+cd/ef');
  assert.equal(call.init.headers.authorization, 'Bearer access-token-1');
  assert.ok(call.init.headers['x-ms-requestid'], 'a request id is sent for traceability');
});

test('resolve rejects an empty token without calling Microsoft', async () => {
  const fetchImpl = stubFetch([tokenResponder()]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(() => client.resolvePurchaseToken('  '), (e) => e.code === 'purchase_token_missing');
  assert.equal(fetchImpl.requests.length, 0);
});

test('a 400 from resolve is reported as an invalid purchase token', async () => {
  const fetchImpl = stubFetch([
    tokenResponder(),
    (url) => (url.includes('/resolve') ? jsonResponse(400, { error: 'bad token' }) : null)
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(
    () => client.resolvePurchaseToken('expired'),
    (e) => e.code === 'purchase_token_invalid'
  );
});

test('a resolve response without an id is treated as malformed', async () => {
  const fetchImpl = stubFetch([
    tokenResponder(),
    (url) => (url.includes('/resolve') ? jsonResponse(200, { nothing: true }) : null)
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(
    () => client.resolvePurchaseToken('tok'),
    (e) => e.code === 'resolve_malformed'
  );
});

test('non-JSON from Microsoft is treated as malformed rather than crashing', async () => {
  const fetchImpl = stubFetch([
    tokenResponder(),
    (url) =>
      url.includes('/resolve')
        ? {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON');
            }
          }
        : null
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(
    () => client.resolvePurchaseToken('tok'),
    (e) => e.code === 'resolve_malformed'
  );
});

test('a rejected credential surfaces a code without echoing the secret', async () => {
  const fetchImpl = stubFetch([
    (url) =>
      url.includes('/oauth2/v2.0/token')
        ? jsonResponse(401, {
            error: 'invalid_client',
            error_description: `secret ${TEST_SECRET} is wrong`
          })
        : null
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  await assert.rejects(
    () => client._getAccessToken(),
    (err) => {
      assert.equal(err.code, 'token_rejected');
      assert.equal(err.status, 401);
      assert.ok(!String(err.message).includes(TEST_SECRET));
      assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(TEST_SECRET));
      return true;
    }
  );
});

test('a network failure during token acquisition does not leak the request body', async () => {
  const fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED (body contained ${TEST_SECRET})`);
  };
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(
    () => client._getAccessToken(),
    (err) => {
      assert.equal(err.code, 'token_request_failed');
      assert.ok(!String(err.message).includes(TEST_SECRET));
      return true;
    }
  );
});

test('a 401 from the fulfillment API drops the cached token so the next call re-authenticates', async () => {
  let tokenRequests = 0;
  let firstCall = true;
  const fetchImpl = stubFetch([
    (url) => {
      if (!url.includes('/oauth2/v2.0/token')) return null;
      tokenRequests += 1;
      return jsonResponse(200, { access_token: `t${tokenRequests}`, expires_in: 3600 });
    },
    (url) => {
      if (!url.includes('/subscriptions/')) return null;
      if (firstCall) {
        firstCall = false;
        return jsonResponse(401, {});
      }
      return jsonResponse(200, subscriptionFixture());
    }
  ]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });

  await assert.rejects(
    () => client.getSubscription('sub-1'),
    (e) => e.code === 'fulfillment_unauthorized'
  );
  await client.getSubscription('sub-1');

  assert.equal(tokenRequests, 2, 'a rejected token must not be reused');
});

test('patchOperation refuses a status Microsoft does not accept', async () => {
  const fetchImpl = stubFetch([tokenResponder()]);
  const client = createFulfillmentClient({ config: TEST_CONFIG, fetchImpl });
  await assert.rejects(
    () => client.patchOperation('sub-1', 'op-1', 'Maybe'),
    (e) => e.code === 'operation_status_invalid'
  );
});
