import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebhookAuthenticator } from '../src/lib/webhookAuth.js';
import {
  FULFILLMENT_CLIENT_ID,
  SAAS_RESOURCE_ID,
  TENANT_ID,
  TEST_CONFIG,
  makeKeys,
  signWebhookToken
} from './helpers.js';

async function authenticatorWithKeys() {
  const { privateKey, keyStore } = await makeKeys();
  return {
    privateKey,
    authenticate: createWebhookAuthenticator({ config: TEST_CONFIG, keyStore })
  };
}

async function rejects(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });
}

test('missing Authorization header is rejected', async () => {
  const { authenticate } = await authenticatorWithKeys();
  await rejects(() => authenticate(undefined), 'auth_header_missing');
  await rejects(() => authenticate(''), 'auth_header_missing');
});

test('non-bearer scheme is rejected', async () => {
  const { authenticate } = await authenticatorWithKeys();
  await rejects(() => authenticate('Basic abc123'), 'auth_scheme_invalid');
  await rejects(() => authenticate('Bearer'), 'auth_scheme_invalid');
});

test('a garbage token is rejected rather than parsed', async () => {
  const { authenticate } = await authenticatorWithKeys();
  await rejects(() => authenticate('Bearer not-a-jwt'), 'auth_token_invalid');
});

test('a token signed by the wrong key is rejected', async () => {
  const { keyStore } = await makeKeys();
  const other = await makeKeys();
  const authenticate = createWebhookAuthenticator({ config: TEST_CONFIG, keyStore });
  const token = await signWebhookToken(other.privateKey);
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_signature_invalid');
});

test('an expired token is rejected', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const nowSec = Math.floor(Date.now() / 1000);
  // Well outside the 60s clock tolerance.
  const token = await signWebhookToken(privateKey, { iat: nowSec - 1200, exp: nowSec - 600 });
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_token_expired');
});

test('a token for the wrong audience is rejected', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, {
    aud: '99999999-9999-9999-9999-999999999999'
  });
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_audience_invalid');
});

test('a token from another tenant is rejected', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, {
    tid: '99999999-9999-9999-9999-999999999999',
    iss: `https://sts.windows.net/${TENANT_ID}/`
  });
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_tenant_invalid');
});

test('a token from an unexpected issuer is rejected', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, { iss: 'https://evil.example/' });
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_issuer_invalid');
});

test('a token from an application other than the Marketplace resource is rejected', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, {
    appid: '99999999-9999-9999-9999-999999999999'
  });
  await rejects(() => authenticate(`Bearer ${token}`), 'auth_appid_invalid');
});

test('a valid token is accepted with appid', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey);
  const claims = await authenticate(`Bearer ${token}`);
  assert.equal(claims.aud, FULFILLMENT_CLIENT_ID);
  assert.equal(claims.tid, TENANT_ID);
});

test('a valid token is accepted when the resource is in azp instead of appid', async () => {
  // Microsoft documents that the value may appear in either claim depending on
  // how the application is set up, so both must work.
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, { appid: null, azp: SAAS_RESOURCE_ID });
  const claims = await authenticate(`Bearer ${token}`);
  assert.equal(claims.azp, SAAS_RESOURCE_ID);
});

test('the v2.0 issuer form is accepted as well as the v1 form', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey, {
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
  });
  const claims = await authenticate(`Bearer ${token}`);
  assert.equal(claims.tid, TENANT_ID);
});

test('the header is matched case-insensitively and tolerates extra whitespace', async () => {
  const { privateKey, authenticate } = await authenticatorWithKeys();
  const token = await signWebhookToken(privateKey);
  const claims = await authenticate(`  bearer   ${token}  `);
  assert.equal(claims.tid, TENANT_ID);
});
