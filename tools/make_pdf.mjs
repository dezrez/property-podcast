/* Render marketing/onepager.html to a print-ready A4 PDF using headless Edge.
 *
 * Chrome's printToPDF produces vector text and embeds the images, so the
 * result stays sharp and selectable. No PDF libraries needed.
 *
 * Usage: node tools/make_pdf.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const SOURCE = resolve('marketing/onepager.html');
const OUTPUT = resolve('marketing/AI-and-UK-Property-The-Daily-Briefing.pdf');
const PORT = 9226;
const PROFILE = process.env.TEMP + '\\cdp-pdf-' + process.pid + '-' + Date.now();
const EDGE = process.env.PDF_BROWSER ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// A4 in inches, which is what printToPDF expects.
const A4_WIDTH_IN = 8.27;
const A4_HEIGHT_IN = 11.69;

let nextId = 1;
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve_, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 40000);
    const on = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(t); ws.removeEventListener('message', on);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve_(m.result);
    };
    ws.addEventListener('message', on);
  });
}

async function main() {
  if (!existsSync(SOURCE)) throw new Error('missing ' + SOURCE);

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch {}
    await sleep(250);
  }
  if (!version) { child.kill(); throw new Error('DevTools endpoint never came up'); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);

  const loaded = new Promise(res => {
    const on = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', on); res(); }
    };
    ws.addEventListener('message', on);
  });
  await send(ws, 'Page.navigate', { url: pathToFileURL(SOURCE).href }, sessionId);
  await loaded;

  // Make sure both images decoded before printing, or they print blank.
  const imgs = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      await Promise.all([...document.images].map(i => i.decode().catch(() => null)));
      return JSON.stringify([...document.images].map(i => ({
        src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight
      })));
    })()`,
    returnByValue: true, awaitPromise: true
  }, sessionId);
  const decoded = JSON.parse(imgs.result.value);
  console.log('images:', decoded.map(i => `${i.src} ${i.w}x${i.h}`).join(' | '));
  const broken = decoded.filter(i => !i.w);
  if (broken.length) throw new Error('image failed to load: ' + broken.map(i => i.src).join(', '));

  const { data } = await send(ws, 'Page.printToPDF', {
    paperWidth: A4_WIDTH_IN,
    paperHeight: A4_HEIGHT_IN,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    scale: 1
  }, sessionId);

  writeFileSync(OUTPUT, Buffer.from(data, 'base64'));
  console.log('wrote', OUTPUT);

  await send(ws, 'Target.closeTarget', { targetId });
  ws.close();
  child.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
