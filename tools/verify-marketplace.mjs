/* Landing-page checks for /marketplace.
 *
 * Serves the real marketplace.html / marketplace.js from disk, but stubs the
 * two things the page cannot reach in a test: the /api/marketplace/* endpoints
 * and the MSAL bundle. Everything else is the shipping code.
 *
 * Usage: node tools/verify-marketplace.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(process.cwd());
const PORT = 5199;
const CDP_PORT = 9233;
const PROFILE = process.env.TEMP + '\\cdp-mkt-' + process.pid + '-' + Date.now();
const EDGE =
  process.env.VERIFY_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const BUYER_CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const PURCHASE_TOKEN = 'test-purchase-token-abc123';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

/** Per-scenario server behaviour, swapped between runs. */
const scenario = {
  hasAccount: false,
  resolveStatus: 200,
  resolveBody: null
};

/** A stand-in for the MSAL bundle exposing only what marketplace.js uses. */
const MSAL_STUB = `
window.msal = {
  PublicClientApplication: function (config) {
    this.config = config;
    this.initialize = function () { return Promise.resolve(); };
    this.handleRedirectPromise = function () { return Promise.resolve(null); };
    this.getAllAccounts = function () {
      return window.__TEST_HAS_ACCOUNT__
        ? [{ username: 'buyer@contoso.com', name: 'Test Buyer' }]
        : [];
    };
    this.setActiveAccount = function () {};
    this.loginRedirect = function () {
      window.__TEST_LOGIN_REDIRECT_CALLED__ = true;
      return Promise.resolve();
    };
  }
};
`;

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    if (path === '/api/marketplace/config') {
      return send(
        200,
        MIME['.json'],
        JSON.stringify({
          buyerClientId: BUYER_CLIENT_ID,
          authority: 'https://login.microsoftonline.com/common'
        })
      );
    }

    if (path === '/api/marketplace/resolve') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      // Record what the page actually sent, so the test can assert the token
      // was forwarded intact.
      scenario.lastResolveBody = raw;
      return send(scenario.resolveStatus, MIME['.json'], JSON.stringify(scenario.resolveBody));
    }

    if (path.startsWith('/vendor/msal-browser')) {
      return send(200, MIME['.js'], MSAL_STUB);
    }

    const filePath = path === '/marketplace' ? '/marketplace.html' : path;
    try {
      const body = await readFile(join(ROOT, filePath.replace(/^\//, '')));
      return send(200, MIME[extname(filePath)] || 'application/octet-stream', body);
    } catch {
      return send(404, 'text/plain', 'not found');
    }
  });

  return new Promise((res) => server.listen(PORT, () => res(server)));
}

/* ------------------------------------------------------------------- CDP */

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
    const on = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id !== id) return;
      clearTimeout(t);
      ws.removeEventListener('message', on);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    };
    ws.addEventListener('message', on);
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

async function main() {
  const server = await startServer();

  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!version) throw new Error('DevTools endpoint never came up');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);

  async function load(pathAndQuery, { hasAccount = false } = {}) {
    await send(
      ws,
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `window.__TEST_HAS_ACCOUNT__ = ${hasAccount ? 'true' : 'false'};` },
      sessionId
    );
    const loaded = new Promise((res) => {
      const on = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.method === 'Page.loadEventFired') {
          ws.removeEventListener('message', on);
          res();
        }
      };
      ws.addEventListener('message', on);
    });
    await send(ws, 'Page.navigate', { url: `http://localhost:${PORT}${pathAndQuery}` }, sessionId);
    await loaded;
    await sleep(900);
  }

  async function evalJs(expression) {
    const r = await send(
      ws,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  const visiblePanel = () =>
    evalJs(`(() => {
      const ids = ['loading','signin','resolving','active','inactive','no-token','error'];
      return ids.filter(id => {
        const el = document.getElementById('panel-' + id);
        return el && !el.hidden;
      }).join(',');
    })()`);

  const activeSubscription = () => ({
    subscription: {
      subscriptionId: 'sub-0001',
      subscriptionName: 'Property Podcast Standard',
      planId: 'property-podcast-standard',
      offerId: 'property-podcast',
      status: 'Subscribed',
      quantity: 1,
      termUnit: 'P1Y',
      isFreeTrial: false,
      isTest: true,
      active: true
    }
  });

  console.log('\nLANDING PAGE');

  // 1. Opened with no purchase token at all.
  await load('/marketplace');
  check('opened without a purchase token shows guidance, not an error', (await visiblePanel()) === 'no-token');

  // 2. Token present but nobody signed in yet.
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: false });
  check('a purchase token with no signed-in buyer prompts Entra sign-in', (await visiblePanel()) === 'signin');
  check(
    'the sign-in button starts the Entra redirect',
    await evalJs(
      `(() => { document.getElementById('signInBtn').click(); return !!window.__TEST_LOGIN_REDIRECT_CALLED__; })()`
    )
  );

  // 3. The token must not linger anywhere it could leak.
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: false });
  const urlNow = await evalJs('window.location.href');
  check('the purchase token is stripped from the address bar', !urlNow.includes(PURCHASE_TOKEN), urlNow);
  check(
    'the purchase token is never rendered into the page',
    !(await evalJs('document.documentElement.outerHTML')).includes(PURCHASE_TOKEN)
  );

  // 4. Signed in, resolve succeeds.
  scenario.resolveStatus = 200;
  scenario.resolveBody = activeSubscription();
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: true });
  check('a resolved active subscription shows the success panel', (await visiblePanel()) === 'active');

  const facts = await evalJs(`document.getElementById('subscriptionFacts').textContent`);
  check(
    'the success panel names the plan and status',
    facts.includes('property-podcast-standard') && facts.includes('Subscribed'),
    facts.replace(/\s+/g, ' ').slice(0, 90)
  );
  check(
    'the page reports the signed-in buyer',
    (await evalJs(`document.getElementById('signedInAs').textContent`)).includes('buyer@contoso.com')
  );
  check(
    'the purchase token was forwarded to the backend intact',
    JSON.parse(scenario.lastResolveBody || '{}').token === PURCHASE_TOKEN
  );
  check(
    'no token appears in the rendered page after a successful resolve',
    !(await evalJs('document.documentElement.outerHTML')).includes(PURCHASE_TOKEN)
  );

  // Optional visual capture of the success state, for review.
  if (process.env.MARKETPLACE_SHOT) {
    const { writeFile } = await import('node:fs/promises');
    await send(
      ws,
      'Emulation.setDeviceMetricsOverride',
      { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await sleep(400);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(process.env.MARKETPLACE_SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  (screenshot written to ' + process.env.MARKETPLACE_SHOT + ')');
  }

  // 5. Resolve fails with an expired token.
  scenario.resolveStatus = 400;
  scenario.resolveBody = { error: 'purchase_token_invalid' };
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: true });
  check('a failed resolve shows the error panel', (await visiblePanel()) === 'error');
  const errText = await evalJs(`document.getElementById('panel-error').textContent`);
  check(
    'the error explains what to do about an expired purchase link',
    /24 hours/.test(errText) && /Configure account/.test(errText)
  );
  check(
    'the error surfaces a diagnostic code',
    (await evalJs(`document.getElementById('errorCode').textContent`)) === 'purchase_token_invalid'
  );

  // 6. Resolve succeeds but the subscription is not active.
  scenario.resolveStatus = 200;
  scenario.resolveBody = {
    subscription: {
      subscriptionId: 'sub-0001',
      planId: 'property-podcast-standard',
      status: 'Suspended',
      active: false
    }
  };
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: true });
  check('a suspended subscription is reported distinctly from an error', (await visiblePanel()) === 'inactive');
  check(
    'the suspended message explains the payment situation',
    /payment/i.test(await evalJs(`document.getElementById('inactiveBody').textContent`))
  );

  // 7. Backend unreachable.
  scenario.resolveStatus = 503;
  scenario.resolveBody = { error: 'not_configured' };
  await load(`/marketplace?token=${PURCHASE_TOKEN}`, { hasAccount: true });
  check('a backend failure is reported as an error, not as success', (await visiblePanel()) === 'error');

  await send(ws, 'Target.closeTarget', { targetId });
  ws.close();
  child.kill();
  server.close();
  await sleep(300);
  try {
    await rm(PROFILE, { recursive: true, force: true });
  } catch {}

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
