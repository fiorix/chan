#!/usr/bin/env node
// Select a window by its newly created CDP target. A freeze receipt is a CDP
// renderer lifecycle reading, not CoreWebView2.IsSuspended.
import { existsSync, writeFileSync } from 'node:fs';

const [mode, port, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const safeUrl = (raw) => {
  let url;
  try { url = new URL(raw); } catch { url = new URL('about:blank'); }
  for (const key of [...url.searchParams.keys()]) {
    const value = url.searchParams.get(key);
    if (key !== 'w' && !/^wake-[0-9a-f]+$/i.test(value ?? '')) url.searchParams.set(key, 'REDACTED');
  }
  if (url.hash) url.hash = '#REDACTED';
  return url;
};
const safeTitle = (raw) => String(raw ?? '')
  .replace(/([?&](?:t|h|token|devserver_token)=)[^&#\s"]+/g, '$1REDACTED')
  .replace(/(#s=)[^&#\s"]+/g, '$1REDACTED');
const targets = async () => (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })).json())
  .filter((target) => target.type === 'page')
  .map((target) => {
    const url = safeUrl(target.url);
    return { id: target.id, url: url.href, path: `${url.origin}${url.pathname}`, windowId: url.searchParams.get('w'), title: safeTitle(target.title) };
  });
if (mode === 'targets') {
  console.log(JSON.stringify(await targets()));
  process.exit(0);
}
if (mode !== 'freeze') throw new Error(`unknown mode ${mode}`);
const [targetId, directory] = args;
const target = (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })).json())
  .find((row) => row.id === targetId);
if (!target?.webSocketDebuggerUrl) throw new Error(`no target ${targetId}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const events = [];
const commands = [];
let nextId = 0;
let freezeAccepted = false;
let activeAccepted = false;
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
  if (message.method === 'Page.lifecycleEvent') events.push({ name: message.params.name, timestamp: message.params.timestamp });
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 12000);
});
const recordCommand = async (method, params = {}) => {
  const result = await send(method, params);
  commands.push({ method, params, result });
  console.log(JSON.stringify({ method, params, result }));
  writeFileSync(`${directory}/cdp-commands.json`, JSON.stringify({ targetId, commands, events }) + '\n');
  return result;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitEvent = async (name) => {
  for (let i = 0; i < 100; i++) {
    if (events.some((event) => event.name === name)) return;
    await pause(100);
  }
  throw new Error(`no ${name} lifecycle event`);
};
try {
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed'));
    setTimeout(() => reject(new Error('CDP websocket timed out')), 10000);
  });
  await recordCommand('Page.enable');
  await recordCommand('Page.setLifecycleEventsEnabled', { enabled: true });
  await recordCommand('Page.setWebLifecycleState', { state: 'frozen' });
  freezeAccepted = true;
  await waitEvent('frozen');
  writeFileSync(`${directory}/frozen.json`, JSON.stringify({ targetId, events }) + '\n');
  for (let i = 0; i < 1400 && !existsSync(`${directory}/cdp-resume`); i++) await pause(100);
  if (!existsSync(`${directory}/cdp-resume`)) throw new Error('resume signal timed out');
  await recordCommand('Page.setWebLifecycleState', { state: 'active' });
  activeAccepted = true;
  await waitEvent('active');
  writeFileSync(`${directory}/active.json`, JSON.stringify({ targetId, events }) + '\n');
} catch (error) {
  let rescueError;
  if (freezeAccepted && !activeAccepted) {
    try {
      await recordCommand('Page.setWebLifecycleState', { state: 'active' });
      activeAccepted = true;
    } catch (rescue) {
      rescueError = String(rescue);
    }
  }
  writeFileSync(`${directory}/cdp-error.json`, JSON.stringify({ targetId, commands, events, error: String(error), rescueError }) + '\n');
  writeFileSync(`${directory}/cdp-error.txt`, String(error) + (rescueError ? `; active rescue: ${rescueError}` : '') + '\n');
  process.exitCode = 3;
} finally {
  ws.close();
}
