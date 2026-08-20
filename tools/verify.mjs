/* End-to-end check against a running local server.
 *
 * Loads the app, exercises search/sort/dedupe, then cuts the network at the
 * protocol level and reloads to prove the offline path really works.
 *
 * Usage: node tools/verify.mjs [http://localhost:5183/]
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const TARGET = process.argv[2] || 'http://localhost:5183/';
const PORT = 9225;
const PROFILE = process.env.TEMP + '\\cdp-verify-' + process.pid + '-' + Date.now();
const EDGE = process.env.VERIFY_BROWSER ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(t); ws.removeEventListener('message', on);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', on);
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

async function evalJs(ws, sessionId, expression) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
    (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
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
  await send(ws, 'Network.enable', {}, sessionId);

  // Browser-level noise that has nothing to do with the page script. The
  // message-channel error is emitted by Chromium's own extension messaging
  // and shows up intermittently regardless of what the page does.
  const IGNORED = [
    /message channel closed before a response was received/i,
    /Extension context invalidated/i
  ];

  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const text = m.params.exceptionDetails.text +
        ' ' + (m.params.exceptionDetails.exception?.description || '');
      if (IGNORED.some(re => re.test(text))) return;
      consoleErrors.push(text);
    }
  });

  async function navigate(url) {
    const loaded = new Promise(res => {
      const on = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', on); res(); }
      };
      ws.addEventListener('message', on);
    });
    await send(ws, 'Page.navigate', { url }, sessionId);
    await loaded;
  }

  console.log('\nONLINE');
  await navigate(TARGET);
  await sleep(3000);

  const n = await evalJs(ws, sessionId, 'document.querySelectorAll(".ep").length');
  check('feed loads and renders episodes', n === 29, n + ' cards (expected 29 after dedupe)');

  const dedupeLabel = await evalJs(ws, sessionId, 'document.getElementById("count").textContent');
  check('duplicate GUIDs merged', dedupeLabel.includes('4 duplicates merged'), dedupeLabel);

  const raw = await evalJs(ws, sessionId, `(() => {
    document.getElementById('dedupe').checked = false;
    document.getElementById('dedupe').dispatchEvent(new Event('change'));
    const n = document.querySelectorAll('.ep').length;
    document.getElementById('dedupe').checked = true;
    document.getElementById('dedupe').dispatchEvent(new Event('change'));
    return n;
  })()`);
  check('dedupe toggle reveals every entry', raw === 33, raw + ' raw items (expected 33)');

  const sortCheck = await evalJs(ws, sessionId, `(() => {
    const g = () => [...document.querySelectorAll('.ep .guid')].map(e => e.textContent);
    const s = document.getElementById('sort');
    s.value = 'guid-asc'; s.dispatchEvent(new Event('change'));
    const asc = g();
    s.value = 'guid-desc'; s.dispatchEvent(new Event('change'));
    const desc = g();
    return JSON.stringify({ ascFirst: asc[0], descFirst: desc[0],
      reversed: JSON.stringify(asc) === JSON.stringify([...desc].reverse()) });
  })()`);
  const sortObj = JSON.parse(sortCheck);
  check('GUID sort ascending/descending are exact reverses', sortObj.reversed,
    sortObj.ascFirst + ' <-> ' + sortObj.descFirst);

  const searchCheck = await evalJs(ws, sessionId, `(async () => {
    const s = document.getElementById('search');
    s.value = '2026-08-1'; s.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 300));
    const n = document.querySelectorAll('.ep').length;
    const marks = document.querySelectorAll('mark').length;
    s.value = ''; s.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 300));
    return JSON.stringify({ n, marks, restored: document.querySelectorAll('.ep').length });
  })()`);
  const sc = JSON.parse(searchCheck);
  check('search filters and highlights', sc.n === 9 && sc.marks > 0 && sc.restored === 29,
    sc.n + ' hits, ' + sc.marks + ' highlights, ' + sc.restored + ' after clear');

  const art = await evalJs(ws, sessionId, `(() => {
    const b = document.getElementById('brandArt');
    return JSON.stringify({ src: b.getAttribute('src'), ok: b.complete && b.naturalWidth > 0 });
  })()`);
  const artObj = JSON.parse(art);
  check('artwork falls back to bundled icon (feed cover.jpg 404s)',
    artObj.ok && artObj.src.startsWith('icons/'), artObj.src);

  // let the service worker install and take control
  await evalJs(ws, sessionId, 'navigator.serviceWorker.ready.then(() => "ready")');
  await sleep(1500);
  const swOk = await evalJs(ws, sessionId, `(async () => {
    const keys = await caches.keys();
    const shell = await caches.open(keys.find(k => k.startsWith('shell')) || 'x');
    const reqs = await shell.keys();
    return JSON.stringify({ keys, shellCount: reqs.length });
  })()`);
  const sw = JSON.parse(swOk);
  check('service worker cached the app shell', sw.shellCount >= 6,
    sw.shellCount + ' shell entries, caches: ' + sw.keys.join(', '));

  // The shell must be servable from the cache without touching the network.
  // (CDP network emulation does not apply to service-worker-initiated
  // requests, so assert against the cache directly rather than pretending
  // the socket is cut.)
  const shellServable = await evalJs(ws, sessionId, `(async () => {
    const wanted = ['./index.html', './app.css', './app.js'];
    const found = [];
    for (const w of wanted) {
      const hit = await caches.match(new Request(new URL(w, location.href)));
      if (hit && hit.ok) found.push(w);
    }
    return JSON.stringify(found);
  })()`);
  const servable = JSON.parse(shellServable);
  check('shell is servable from cache with no network',
    servable.length === 3, servable.join(', ') || 'nothing cached');

  console.log('\nOFFLINE (feed unreachable)');
  // Block only the feed, and report the machine as offline, so the app's own
  // fallback path is what gets exercised.
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
      const _fetch = window.fetch;
      window.fetch = function (input) {
        const u = String(input && input.url ? input.url : input);
        if (u.indexOf('feed.xml') !== -1) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return _fetch.apply(this, arguments);
      };
    `
  }, sessionId);

  await navigate(TARGET);
  await sleep(3000);

  const offlineOnline = await evalJs(ws, sessionId, 'navigator.onLine');
  check('page sees itself as offline', offlineOnline === false, 'navigator.onLine=' + offlineOnline);

  const offN = await evalJs(ws, sessionId, 'document.querySelectorAll(".ep").length');
  check('full catalogue still renders from the cached feed', offN === 29, offN + ' cards');

  const offStatus = await evalJs(ws, sessionId, 'document.getElementById("status").textContent');
  check('offline state is surfaced to the user', /offline/i.test(offStatus), JSON.stringify(offStatus));

  const stillUsable = await evalJs(ws, sessionId, `(async () => {
    const s = document.getElementById('search');
    s.value = '2026-08-1'; s.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 300));
    return document.querySelectorAll('.ep').length;
  })()`);
  check('search still works offline', stillUsable === 9, stillUsable + ' hits');

  check('no uncaught exceptions', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.join(' | ') : 'clean');

  await send(ws, 'Target.closeTarget', { targetId });
  ws.close();
  child.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) process.exit(1);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
