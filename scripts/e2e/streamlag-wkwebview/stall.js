// Paste into the Web Inspector console of the window showing the flood.
// Blocks the page's main thread for 30 s, five times, and keeps the windows.
(async () => {
  const RUNS = 5, STALL_MS = 30_000, SETTLE_MS = 20_000;
  if (document.querySelector('.xterm-screen')) throw new Error('this terminal is on xterm.js; the measurement is for ghostty');
  if (!document.querySelector('canvas')) throw new Error('no terminal canvas in this page: open the console of the window showing the flood');
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const beats = [];
  const timer = setInterval(() => beats.push(Date.now()), 50);
  const stalls = [];
  window.__stalls = stalls;
  console.log(`stall run started: ${RUNS} stalls, about ${Math.ceil(RUNS * (STALL_MS + SETTLE_MS) / 60_000)} minutes; leave this window visible`);
  for (let run = 1; run <= RUNS; run++) {
    await wait(SETTLE_MS);
    const visible = document.visibilityState === 'visible';
    const startMs = Date.now();
    while (Date.now() < startMs + STALL_MS) { /* the stall */ }
    const endMs = Date.now();
    await wait(250);
    let beatGapMs = 0;
    for (let index = 1; index < beats.length; index++) {
      beatGapMs = Math.max(beatGapMs, Math.min(beats[index], endMs) - Math.max(beats[index - 1], startMs));
    }
    stalls.push({ run, startMs, endMs, beatGapMs, visible });
    console.log(`stall ${run}/${RUNS} done`);
  }
  clearInterval(timer);
  console.log('STALLS_DONE ' + JSON.stringify(stalls));
})().catch((error) => console.error('STALL_FAILED ' + error.message));
