/* Capture the manifest screenshots with headless Edge over the DevTools
 * protocol. No npm dependencies — Node's built-in fetch and WebSocket only.
 *
 * Usage: node tools/shoot.mjs http://localhost:5183/
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const TARGET = process.argv[2] || 'http://localhost:5183/';
const PORT = 9223;
// A unique profile per run: reusing one lets a previously registered service
// worker serve a cached build into the screenshots.
const PROFILE = process.env.TEMP + '\\cdp-shoot-' + process.pid + '-' + Date.now();

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* Preferences persist in localStorage, so without an explicit reset each shot
   inherits whatever the previous one left behind — which is how a marketing
   screenshot ends up sorted oldest-first showing duplicate badges. */
const RESET = `
  var s = document.getElementById('sort');
  if (s.value !== 'guid-desc') { s.value = 'guid-desc'; s.dispatchEvent(new Event('change')); }
  var d = document.getElementById('dedupe');
  if (!d.checked) { d.checked = true; d.dispatchEvent(new Event('change')); }
  var q = document.getElementById('search');
  if (q.value) { q.value = ''; q.dispatchEvent(new Event('input')); }
`;

/* Load an episode and hold it paused at the start, but only after its metadata
   has arrived, so the player shows a real duration rather than 0:00 / 0:00. */
const SHOW_PLAYER = `(async () => {
  ${RESET}
  var b = document.querySelector('.ep .ep-play');
  if (b) b.click();
  var a = document.getElementById('audio');
  for (var i = 0; i < 50 && !(a.duration > 0); i++) {
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  a.pause();
  a.currentTime = 0;
  return 'ok';
})()`;

// ...and with a search running, to show filtering and highlighting.
const SHOW_SEARCH = `(async () => {
  await ${SHOW_PLAYER};
  var s = document.getElementById('search');
  s.value = '2026-08-1';
  s.dispatchEvent(new Event('input'));
  return 'ok';
})()`;

// Sort by GUID ascending, to show the ordering control doing something.
const SHOW_SORT = `(async () => {
  await ${SHOW_PLAYER};
  var s = document.getElementById('sort');
  s.value = 'guid-asc';
  s.dispatchEvent(new Event('change'));
  return 'ok';
})()`;

/* Microsoft Store desktop screenshots must be at least 1366x768 (.png, under
   50 MB). The manifest's own `screenshots` entries are separate and only feed
   the browser's install UI, so the narrow one stays small. */
const SHOTS = [
  { file: 'screenshots/wide.png', width: 1366, height: 768, prep: SHOW_PLAYER },
  { file: 'screenshots/narrow.png', width: 540, height: 900, prep: SHOW_PLAYER },
  { file: 'screenshots/store-2-search.png', width: 1366, height: 768, prep: SHOW_SEARCH },
  { file: 'screenshots/store-3-sort.png', width: 1366, height: 768, prep: SHOW_SORT },
  // Partner/ISV listings commonly demand exactly 1280x720.
  { file: 'marketing/screenshot-1280x720.png', width: 1280, height: 720, prep: SHOW_PLAYER },
  { file: 'marketing/screenshot-search-1280x720.png', width: 1280, height: 720, prep: SHOW_SEARCH }
];

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 30000);
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
  });
}

async function main() {
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  mkdirSync('screenshots', { recursive: true });
  mkdirSync('marketing', { recursive: true });

  const bin = process.env.SHOOT_BROWSER || EDGE;
  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  // wait for the debugger endpoint to come up
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch {}
    await sleep(250);
  }
  if (!version) { child.kill(); throw new Error('DevTools endpoint never came up'); }
  console.log('browser:', version.Browser);

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });

  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);

  for (const shot of SHOTS) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: false
    }, sessionId);

    const loaded = new Promise((resolve) => {
      const onMessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) {
          ws.removeEventListener('message', onMessage);
          resolve();
        }
      };
      ws.addEventListener('message', onMessage);
    });

    await send(ws, 'Page.navigate', { url: TARGET }, sessionId);
    await loaded;
    // let the feed request settle and the list paint
    await sleep(2500);

    const count = await send(ws, 'Runtime.evaluate', {
      expression: 'document.querySelectorAll(".ep").length', returnByValue: true
    }, sessionId);
    console.log(shot.file, '->', count.result.value, 'episode cards');

    if (shot.prep) {
      await send(ws, 'Runtime.evaluate', {
        expression: shot.prep, returnByValue: true, awaitPromise: true
      }, sessionId);
      await sleep(900);
    }

    const { data } = await send(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shot.file, Buffer.from(data, 'base64'));
    console.log('wrote', shot.file);
  }

  await send(ws, 'Target.closeTarget', { targetId });
  ws.close();
  child.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
