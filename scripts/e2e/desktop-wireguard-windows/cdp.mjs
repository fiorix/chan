// cdp.mjs: a dependency-free CDP driver for WebView2's remote debugging
// port (Node 22 or later, for the global WebSocket and fetch).
//   node cdp.mjs page PORT
//     prints the id of the first window's page target and, after a space,
//     its URL without the query (which carries the window's token); exits 1
//     when there is none. The launcher, served at the root, is not a window.
//   node cdp.mjs launcher PORT
//     prints the launcher's target id, never its URL or bearer.
//   node cdp.mjs targets PORT
//     writes target ids, titles and URL paths with query values redacted.
//   node cdp.mjs launcher-key PORT TARGET_ID
//     sends a trusted Ctrl+Shift+P keydown/up to a host webview.
//   node cdp.mjs eval PORT TARGET_ID EXPRESSION
//     evaluates in that webview and prints only the returned value.
//   node cdp.mjs nav PORT TARGET_ID URL OUT_PREFIX [WAIT_MS]
//     navigates the target, waits WAIT_MS (default 8000) for the page's own
//     fetch and WebSocket, then writes OUT_PREFIX.json (the main document's
//     response, the navigation's errorText, the WebSocket handshakes and the
//     page's text) and OUT_PREFIX.png (Page.captureScreenshot).
import { writeFileSync } from 'node:fs';

const [mode, port, ...rest] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const targets = async () => (await fetch(`${base}/json/list`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'targets') {
  const listing = (await targets()).map(({ id, type, title, url }) => {
    let safeUrl;
    try {
      const parsed = new URL(url);
      safeUrl = parsed.origin + parsed.pathname + (parsed.search ? '?[query]' : '');
    } catch {
      safeUrl = String(url).split('?')[0];
    }
    return { id, type, title, url: safeUrl };
  });
  console.log(JSON.stringify(listing, null, 2));
  process.exit(0);
}
if (mode === 'page') {
  const parse = (u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };
  const page = (await targets())
    .map((t) => ({ t, u: parse(t.url) }))
    .find(({ t, u }) => t.type === 'page' && u && u.protocol === 'http:' && u.pathname !== '/');
  if (!page) process.exit(1);
  console.log(`${page.t.id} ${page.u.origin}${page.u.pathname}`);
  process.exit(0);
}
if (mode === 'launcher') {
  const launcher = (await targets()).find((target) => {
    try {
      const url = new URL(target.url);
      return target.type === 'page' && url.hostname === '127.0.0.1' && url.pathname === '/' && url.searchParams.has('t');
    } catch {
      return false;
    }
  });
  if (!launcher) process.exit(1);
  console.log(launcher.id);
  process.exit(0);
}
if (mode !== 'nav' && mode !== 'eval' && mode !== 'launcher-key') {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

const [targetId, url, outPrefix, waitArg] = rest;
const target = (await targets()).find((t) => t.id === targetId);
if (!target) {
  console.error(`no target ${targetId}`);
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const record = { url, documents: [], failures: [], wsHandshakes: [] };
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  const p = msg.params;
  if (msg.method === 'Network.responseReceived' && p.type === 'Document') {
    record.documents.push({ url: p.response.url, status: p.response.status, remote: `${p.response.remoteIPAddress}:${p.response.remotePort}` });
  } else if (msg.method === 'Network.loadingFailed') {
    record.failures.push({ type: p.type, errorText: p.errorText });
  } else if (msg.method === 'Network.webSocketHandshakeResponseReceived') {
    record.wsHandshakes.push(p.response.status);
  }
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('CDP websocket error'));
});
const send = (method, params = {}, timeoutMs = 90000) => {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
};
if (mode === 'launcher-key') {
  await send('Page.bringToFront');
  const key = { modifiers: 10, code: 'KeyP', key: 'P', keyIdentifier: 'U+0050', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 };
  await send('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
  await send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
  console.log('sent');
  ws.close();
  process.exit(0);
}
if (mode === 'eval') {
  const result = await send('Runtime.evaluate', { expression: url, awaitPromise: true, returnByValue: true }, 30000);
  if (result.exceptionDetails || !Object.hasOwn(result.result, 'value')) throw new Error('webview evaluation failed');
  console.log(result.result.value);
  ws.close();
  process.exit(0);
}
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
const t0 = Date.now();
try {
  const nav = await send('Page.navigate', { url });
  record.errorText = nav.errorText || null;
} catch (e) {
  record.navigateError = String(e);
}
record.navigateMs = Date.now() - t0;
await sleep(Number(waitArg || 8000));
try {
  const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({href: location.href, title: document.title, text: document.body ? document.body.innerText : ""})', returnByValue: true }, 15000);
  record.page = JSON.parse(ev.result.value);
} catch (e) {
  record.evaluateError = String(e);
}
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, 30000);
  writeFileSync(`${outPrefix}.png`, Buffer.from(shot.data, 'base64'));
} catch (e) {
  record.screenshotError = String(e);
}
writeFileSync(`${outPrefix}.json`, JSON.stringify(record, null, 2));
ws.close();
process.exit(0);
