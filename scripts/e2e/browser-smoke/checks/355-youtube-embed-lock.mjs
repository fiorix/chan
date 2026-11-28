// A YouTube embed under the screen lock, read on a real player. Its frame is
// cross-origin, so the page reaches the player only through the API its src
// enables, and the only reading of whether it plays is the <video> element
// inside the frame: its `paused` and `currentTime`, read through the frame
// handle about four times a second, never from the player's messages.
//
// This check needs outbound network: the browser loads YouTube's player and
// the video. Before anything else it resolves the embed host and opens one
// TCP connection to its HTTPS port (nothing is sent on it); without either it
// stops as an environment error (exit 2) naming what is missing, and so does
// every later reading that shows the network or the third party instead of
// the player (no route, a consent or bot page, an unavailable video, an
// advertisement, a clock that stalls with no pause). The suite's own guest
// runner gives a check a loopback and no route out, so this check runs
// through `networked-guest.sh` beside it, in a guest with a network namespace
// of its own.
//
// The check page serves its own lock state (a PIN set, the inactivity timer
// off) and answers each PIN check as the leg wants, as check 305 does, through
// an interception on the page's own target only, so the player's frame and
// its media requests are not intercepted. One document holds the video and a
// map, each written as an image link, open in the editor; a window-wide
// survey carries the later frames. Legs, in order:
//
//   src       the editor's video frame src is the embed address with the
//             player API enabled and nothing else; read again later on the
//             survey's image-link frame, which the Markdown renderer builds;
//   play      one click at the frame's centre starts it; 3 s of advancing
//             clock;
//   control   with no lock and nothing posted, it keeps playing for 5 s, so a
//             pause under the lock is the lock's;
//   lock      the app's own lock command: paused within 1.5 s of the cover,
//             at its position (not 0), and held at it for 5 s;
//   unlock    after the PIN, still paused at the same position for 5 s;
//   autoplay  control for the raw form: a survey whose body holds
//             `<iframe src=".../embed/<id>?autoplay=1&mute=1" allow="autoplay">`
//             with no lock up starts by itself (else the raw leg is unread);
//   image     a survey that arrives under the lock with an image-link video:
//             it never plays under the lock, nor in 5 s after the unlock;
//   raw       the raw autoplay frame in that survey never starts under the
//             lock, nor in 5 s after the unlock;
//   map       the map frame's src is the map embed address, with no player
//             parameter, read at the start and again at the end.
//
// A leg whose own control did not hold is unread, not passed. A product
// failure fails the check; otherwise an environment or interaction error
// makes it an error; only every leg read and held passes.
//
// What reaches the third party is what the app's embeds send: the frames'
// requests with headless Chrome's user agent and, by the embed's referrer
// policy, a Referer of the check page's address (loopback, its window id; the
// app drops the token from the address at load and keeps its layout in the
// fragment). The video is the player API documentation's example id. The
// check adds the DNS lookup and the bare TCP connection above, a click on the
// player and the frame reads, which stay in the browser.

import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOW_CARD, answerOpenSurveys, raiseSurvey, surveyOutcome, waitForCard } from "../lib/keyboard-owners.mjs";
import { LOCK, checkWindowId, settle } from "../lib/keyboard-layers.mjs";
import { closeActiveTab, closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cut = (s, n = 300) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}...` : s);
const describe = (error) => maskTokens(String(error?.message ?? error).split("\n")[0]);

const VIDEO_ID = "M7lc1UVf-VE";
const EMBED_HOST = "www.youtube-nocookie.com";
const EMBED_ORIGIN = `https://${EMBED_HOST}`;
const WATCH_LINK = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const SRC_WANT = `${EMBED_ORIGIN}/embed/${VIDEO_ID}?enablejsapi=1`;
const MAP_LINK = "https://www.google.com/maps?q=0,0";
const MAP_SRC_WANT = "https://www.google.com/maps?q=0%2C0&output=embed";
const RAW_HTML = `<iframe src="${EMBED_ORIGIN}/embed/${VIDEO_ID}?autoplay=1&amp;mute=1" allow="autoplay"></iframe>`;
const DOC_TEXT = `# Embed under the lock\n\nA video and a map, each written as an image link.\n\n![](${WATCH_LINK})\n\n![](${MAP_LINK})\n`;
const PIN = ".screensaver-pin";
const PIN_TEXT = "2468";
const EDITOR_VIDEO = ".editor-tab.active iframe.cm-md-embed-youtube";
const EDITOR_MAP = ".editor-tab.active iframe.cm-md-embed-maps";
const SURVEY_IMAGE = `${WINDOW_CARD} iframe.md-embed-youtube`;
const SURVEY_RAW = `${WINDOW_CARD} iframe:not(.md-embed)`;

const SAMPLE_MS = 250;
const READ_BOUND_MS = 3_000;
const PLAYER_BOUND_MS = 30_000;
const START_BOUND_MS = 20_000;
const ADVANCE_SPAN_MS = 3_000;
const ADVANCE_GAIN_S = 2.0;
const STEP_S = 0.05;
const CONTROL_MS = 5_000;
const CONTROL_GAIN_S = 3.0;
const PAUSE_WITHIN_MS = 1_500;
const HOLD_MS = 5_000;
const STILL_FOR_MS = 3_000;
const STILL_EPSILON_S = 0.1;
// How far a paused clock may read from the one the run predicts from the
// last reading before the lock: each reading is taken some milliseconds
// after its timestamp, so the two ends of the interval carry that latency.
const POSITION_SLACK_S = 0.5;
const RUNNING_GAIN_S = 1.0;
const UNDER_LOCK_WATCH_MS = 15_000;
const STARTED_S = 0.5;
const SURVEY_TIMEOUT_S = 240;

// ---------------------------------------------------------------------------
// Readings over samples. A sample is { t, video: { paused, time, ready,
// ended, error, duration } | null, playerClass, url, errorText, text,
// readError }.

const isAd = (s) => typeof s.playerClass === "string" && /\bad-(showing|interrupting)\b/.test(s.playerClass);

// A read that worked but found no <video> reads as a player that is not
// playing, until a sample has had one: the player makes the element on its
// first play. After that, and for a read that failed, there is no reading.
const NOT_PLAYING = Object.freeze({ paused: true, time: 0, ready: 0, ended: false, error: null, duration: null, absent: true });
function readings(samples) {
  let hadVideo = false;
  return samples.flatMap((s) => {
    if (s.video) {
      hadVideo = true;
      return [s];
    }
    return s.readError || hadVideo ? [] : [{ ...s, video: NOT_PLAYING }];
  });
}

// The first stretch of at least spanMs over which the clock runs, with no
// advertisement, gaining at least gainS; null when there is none.
function advancingStretch(samples, spanMs = ADVANCE_SPAN_MS, gainS = ADVANCE_GAIN_S) {
  let start = null;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1].video;
    const cur = samples[i].video;
    if (!(prev && cur && !isAd(samples[i]) && cur.time > prev.time + STEP_S)) {
      start = null;
      continue;
    }
    start ??= samples[i - 1];
    if (samples[i].t - start.t >= spanMs && cur.time - start.video.time >= gainS) return { from: start, to: samples[i] };
  }
  return null;
}

// What the frame shows when it is not a playable player: the network or the
// third party, not the product. Null when nothing is wrong that can be named.
function environmentOf(s) {
  const url = s.url || s.frameUrl || "";
  if (url.startsWith("chrome-error:")) return "no route to the host (the frame shows Chrome's error page)";
  if (!url || url === "about:blank") return null;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host !== EMBED_HOST) return `consent or bot interstitial: the frame is at ${host}`;
  const words = `${s.text || ""}\n${s.errorText || ""}`;
  const bot = words.match(/[^\n]*(not a bot|confirm you.?re not|unusual traffic|before you continue)[^\n]*/i);
  if (bot) return `consent or bot interstitial: "${bot[0].trim().slice(0, 120)}"`;
  if (s.errorText) {
    const line = s.errorText.split("\n").find((l) => l.trim()) ?? s.errorText;
    if (/can.?t play|not supported|format|codec/i.test(s.errorText)) return `no playable codec: "${line.trim().slice(0, 120)}"`;
    return `video unavailable or player error: "${line.trim().slice(0, 120)}"`;
  }
  if (s.video && (s.video.error === 3 || s.video.error === 4)) return `no playable codec: media error ${s.video.error}`;
  if (s.video?.ended) return `the video ended at ${s.video.time.toFixed(2)} s`;
  if (isAd(s)) return "an advertisement in place of the video";
  return null;
}

function environmentIn(samples) {
  for (const s of samples) {
    const what = environmentOf(s);
    if (what) return what;
  }
  return null;
}

const environment = (what) => ({ verdict: "environment", detail: what });
const failed = (detail) => ({ verdict: "failed", detail });
const passed = (detail) => ({ verdict: "passed", detail });

// The control: with no lock up and nothing posted the clock runs over the
// whole window. A pause here is the product's (an embed with no lock behaves
// as it always did); a clock that stalls without one is the network's.
function controlVerdict(samples) {
  const what = environmentIn(samples);
  if (what) return environment(what);
  const read = samples.filter((s) => s.video);
  if (read.length < 2) return environment(`${read.length} reading(s) of the video over the control window`);
  const pausedAt = read.find((s) => s.video.paused);
  if (pausedAt) return failed(`paused at ${pausedAt.video.time.toFixed(2)} s, ${pausedAt.t - read[0].t} ms into the window, with no lock up and nothing posted`);
  const first = read[0];
  const last = read.at(-1);
  const gain = last.video.time - first.video.time;
  if (gain < CONTROL_GAIN_S) return environment(`the clock stalled without a pause: gain ${gain.toFixed(2)} s over ${last.t - first.t} ms (readyState ${last.video.ready})`);
  return passed(`kept playing: ${first.video.time.toFixed(2)} to ${last.video.time.toFixed(2)} s over ${last.t - first.t} ms`);
}

// Paused within PAUSE_WITHIN_MS of coverT, at its position, and held there
// for HOLD_MS. before is the last reading taken before the lock command.
function pauseVerdict(samples, coverT, before) {
  const what = environmentIn(samples);
  if (what) return environment(what);
  const read = samples.filter((s) => s.video);
  if (read.length < 2) return environment(`${read.length} reading(s) of the video under the lock`);
  const at = read.findIndex((s) => s.video.paused);
  if (at < 0) {
    const gain = read.at(-1).video.time - read[0].video.time;
    if (gain > RUNNING_GAIN_S) return failed(`still playing under the lock: the clock gained ${gain.toFixed(2)} s over ${read.at(-1).t - read[0].t} ms after the cover came up`);
    return environment(`the clock stalled under the lock without a pause: gain ${gain.toFixed(2)} s`);
  }
  const pausedAt = read[at];
  const delay = pausedAt.t - coverT;
  if (delay > PAUSE_WITHIN_MS) return failed(`paused ${delay} ms after the cover came up, past the ${PAUSE_WITHIN_MS} ms bound, at ${pausedAt.video.time.toFixed(2)} s`);
  const moved = read.slice(at).find((s) => !s.video.paused || Math.abs(s.video.time - pausedAt.video.time) >= STILL_EPSILON_S);
  if (moved) return failed(`paused at ${pausedAt.video.time.toFixed(2)} s, then ran under the lock: ${moved.video.time.toFixed(2)} s, paused ${moved.video.paused}, ${moved.t - coverT} ms after the cover`);
  const span = read.at(-1).t - pausedAt.t;
  if (span < HOLD_MS) return environment(`the readings after the pause cover ${span} ms, under ${HOLD_MS} ms`);
  const pos = pausedAt.video.time;
  const latest = before.video.time + (pausedAt.t - before.t) / 1000 + POSITION_SLACK_S;
  if (pos < before.video.time - POSITION_SLACK_S || pos > latest) {
    return failed(`paused at ${pos.toFixed(2)} s, not at its position: ${before.video.time.toFixed(2)} s ${pausedAt.t - before.t} ms before`);
  }
  return { ...passed(`paused ${delay} ms after the cover at ${pos.toFixed(2)} s (${before.video.time.toFixed(2)} s before the lock), held ${span} ms`), position: pos };
}

// After the unlock: paused at held (the lock's position, or the first reading
// when the lock leg read none) for HOLD_MS. Nothing resumes it.
function holdVerdict(samples, held) {
  const what = environmentIn(samples);
  if (what) return environment(what);
  const read = samples.filter((s) => s.video);
  if (read.length < 2) return environment(`${read.length} reading(s) of the video after the unlock`);
  const at = held ?? read[0].video.time;
  const moved = read.find((s) => !s.video.paused || Math.abs(s.video.time - at) >= STILL_EPSILON_S);
  if (moved) {
    const gain = read.at(-1).video.time - read[0].video.time;
    return failed(`not held after the unlock: ${moved.video.time.toFixed(2)} s, paused ${moved.video.paused}, ${moved.t - read[0].t} ms in (held at ${at.toFixed(2)} s; the clock gained ${gain.toFixed(2)} s over ${read.at(-1).t - read[0].t} ms)`);
  }
  const span = read.at(-1).t - read[0].t;
  if (span < HOLD_MS - SAMPLE_MS) return environment(`the readings after the unlock cover ${span} ms, under ${HOLD_MS} ms`);
  return passed(`still paused at ${at.toFixed(2)} s over ${span} ms after the unlock`);
}

// A frame that must not play: no advancing stretch and no clock past
// STARTED_S over the whole watch, with readings to within a second of its end.
function neverStartedVerdict(samples, where) {
  const what = environmentIn(samples);
  if (what) return environment(what);
  const read = readings(samples);
  if (read.length < 2) return environment(`${read.length} reading(s) of the frame ${where}`);
  const unread = samples.at(-1).t - read.at(-1).t;
  if (unread > 4 * SAMPLE_MS) return environment(`no reading of the frame over the last ${unread} ms ${where}`);
  const stretch = advancingStretch(read);
  const furthest = Math.max(...read.map((s) => s.video.time));
  if (stretch || furthest > STARTED_S) {
    return failed(`played ${where}: clock ${stretch ? `${stretch.from.video.time.toFixed(2)} to ${stretch.to.video.time.toFixed(2)} s` : `reached ${furthest.toFixed(2)} s`}`);
  }
  // A held frame reads paused, or has made no <video>; one that reads playing
  // with its clock standing is a stall, which says nothing of a hold.
  const stalled = read.filter((s) => s.t >= read.at(-1).t - STILL_FOR_MS).find((s) => !s.video.paused);
  if (stalled) return environment(`the frame reads playing ${where} with its clock at ${stalled.video.time.toFixed(2)} s: a stall, not a hold`);
  const absent = read.every((s) => s.video.absent);
  return passed(`never started ${where}: furthest clock ${furthest.toFixed(2)} s over ${read.at(-1).t - read[0].t} ms${absent ? " (no <video> made)" : ""}`);
}

// ---------------------------------------------------------------------------
// The frame instrument.

function bounded(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Runs inside the embed frame; puppeteer serialises it.
function frameSnapshot(full) {
  const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
  const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  const err = document.querySelector(".ytp-error");
  const errShown = !!err && err.getClientRects().length > 0 && getComputedStyle(err).display !== "none";
  return {
    url: location.href,
    video: v
      ? { paused: v.paused, time: v.currentTime, ready: v.readyState, ended: v.ended, error: v.error ? v.error.code : null, duration: Number.isFinite(v.duration) ? v.duration : null }
      : null,
    playerClass: player ? String(player.className) : null,
    largePlay: !!document.querySelector(".ytp-large-play-button"),
    errorText: errShown ? (err.innerText || "").trim().slice(0, 300) : null,
    text: full && document.body ? (document.body.innerText || "").trim().slice(0, 400) : null,
  };
}

async function snapshot(handle, full = false) {
  const t = Date.now();
  try {
    const frame = await bounded(handle.contentFrame(), READ_BOUND_MS, "frame handle");
    if (!frame) return { t, video: null, readError: "no content frame" };
    const frameUrl = frame.url();
    try {
      return { t, frameUrl, ...(await bounded(frame.evaluate(frameSnapshot, full), READ_BOUND_MS, "frame read")) };
    } catch (error) {
      return { t, frameUrl, video: null, readError: describe(error) };
    }
  } catch (error) {
    return { t, video: null, readError: describe(error) };
  }
}

// A frame under watch: its element handle and every sample taken of it.
function tracked(name, handle) {
  return { name, handle, samples: [], playerWait: [] };
}

// Samples every frame in turn about every SAMPLE_MS until untilT or until
// stop(taken) holds for the first frame; answers the samples this call took,
// per frame.
async function watch(frames, untilT, stop = () => false) {
  const taken = frames.map(() => []);
  for (;;) {
    const t = Date.now();
    for (const [i, f] of frames.entries()) {
      const s = await snapshot(f.handle);
      f.samples.push(s);
      taken[i].push(s);
    }
    if (stop(taken[0]) || Date.now() >= untilT) return taken;
    await sleep(Math.max(0, SAMPLE_MS - (Date.now() - t)));
  }
}

// Wait for the player: a player element with its <video> or the large play
// button that stands for it before the first play.
async function waitForPlayer(f) {
  const until = Date.now() + PLAYER_BOUND_MS;
  let last = null;
  while (Date.now() < until) {
    last = await snapshot(f.handle, true);
    f.playerWait.push(last);
    f.samples.push(last);
    const what = environmentOf(last);
    if (what) return environment(what);
    if (last.playerClass && (last.video || last.largePlay)) return null;
    await sleep(SAMPLE_MS);
  }
  if (!f.playerWait.some((s) => !s.readError)) return environment(`every read of the ${f.name} frame failed (last: ${cut(last?.readError ?? "none", 160)})`);
  return environment(`no player in the ${f.name} frame after ${PLAYER_BOUND_MS} ms (url ${cut(last?.url ?? last?.frameUrl ?? "?", 120)})`);
}

async function attributesOf(handle) {
  return handle.evaluate((el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])));
}

// The network, read before the browser is asked for anything: the embed
// host resolves, and its HTTPS port accepts a connection, closed at once. The
// connection dials the name with both address families raced, as the browser
// does, so a guest with an IPv4 route only is not refused for an IPv6 answer.
async function outboundRoute() {
  const reading = { host: EMBED_HOST, port: 443, ok: false };
  try {
    reading.addresses = (await bounded(lookup(EMBED_HOST, { all: true }), 10_000, "DNS lookup")).map((a) => a.address);
  } catch (error) {
    reading.missing = `DNS: ${EMBED_HOST} does not resolve (${describe(error)})`;
    return reading;
  }
  try {
    reading.connected = await new Promise((resolve, reject) => {
      const socket = connect({ host: EMBED_HOST, port: 443, autoSelectFamily: true });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("no answer within 10000 ms"));
      }, 10_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        const remote = socket.remoteAddress;
        socket.destroy();
        resolve(remote);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } catch (error) {
    reading.missing = `a route: TCP to ${EMBED_HOST}:443 fails (${describe(error)})`;
    return reading;
  }
  reading.ok = true;
  return reading;
}

const environmentError = (message, report) => Object.assign(new Error(message), { smokeEnvironment: true, smokeDetails: report });


// The report as saved: frames keep their samples, not their element handles.
const serialize = (value) => JSON.stringify(value, (key, entry) => (key === "handle" ? undefined : entry), 2);

export default {
  name: "youtube-embed-lock",
  async run(ctx) {
    const report = { videoId: VIDEO_ID, legs: {}, frames: {}, steps: [], interaction: [], cleanupErrors: [], pageErrors: [], lockServed: [] };
    const save = () => writeFileSync(join(ctx.outDir, "355-youtube-embed-lock.json"), `${serialize(report)}\n`);
    report.network = await outboundRoute();
    if (!report.network.ok) {
      save();
      throw environmentError(`no outbound network, which this check needs to play a real YouTube embed: ${report.network.missing}. Run it where the browser has a route out (networked-guest.sh beside this suite).`, report);
    }
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");

    const { page } = ctx;
    report.browserVersion = await page.browser().version().catch(() => null);
    page.on("pageerror", (error) => report.pageErrors.push(maskTokens(String(error?.message ?? error)).slice(0, 500)));
    const step = (name) => {
      report.step = name;
      report.steps.push({ name, t: Date.now() });
    };
    const leg = (name, result) => {
      report.legs[name] = result;
      save();
      return result;
    };

    // The served lock state and the answer to the next PIN check. The
    // interception is on the page's own target, so it never sees a request
    // of the player's frame.
    const lock = { accept: false, verifications: 0 };
    const served = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: true };
    const cdp = await page.createCDPSession();
    cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
      const path = new URL(request.url).pathname;
      let body = null;
      if (path.endsWith("/api/screensaver/state")) body = served;
      if (path.endsWith("/api/screensaver/verify")) {
        lock.verifications += 1;
        body = { verified: lock.accept };
      }
      report.lockServed.push({ t: Date.now(), path, answered: body });
      const sent = body
        ? cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
        })
        : cdp.send("Fetch.continueRequest", { requestId });
      sent.catch((error) => report.interaction.push(`lock state answer for ${path}: ${describe(error)}`));
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/screensaver/*", requestStage: "Request" }] });

    const suffix = Date.now().toString(36);
    const relative = `embed-lock-355-${suffix}`;
    const docPath = `${relative}/video.md`;
    const absolute = join(ctx.workspaceDir, relative);
    const terminalName = `Embed355-${suffix}`;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const calls = [];
    let windowId = "";
    const shell = (args, timeout = 30_000) => ctx.exec(ctx.chanBin, ["shell", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout,
    });
    // `cs terminal survey` blocks until the survey resolves.
    const cs = (args) => shell(["terminal", ...args], (SURVEY_TIMEOUT_S + 30) * 1000);

    const lockNow = async () => {
      await dispatchCommand(page, "app.screensaver.lock");
      await page.waitForSelector(LOCK, { timeout: 10_000 });
      return Date.now();
    };
    // Wake the cover with a press on it, since the keyboard may still be in
    // the player's frame, whose keys seek; then type the PIN and have it
    // accepted.
    const unlock = async () => {
      await page.waitForSelector(LOCK, { timeout: 10_000 });
      if (!(await page.$(PIN))) {
        await page.mouse.click(8, 8);
        await page.waitForSelector(PIN, { visible: true, timeout: 10_000 });
      }
      await page.focus(PIN);
      await page.type(PIN, PIN_TEXT);
      lock.accept = true;
      try {
        await page.keyboard.press("Enter");
        await page.waitForSelector(LOCK, { hidden: true, timeout: 15_000 });
      } finally {
        lock.accept = false;
      }
      return Date.now();
    };
    const survey = async (title, body) => {
      const call = raiseSurvey(cs, ["--tab-group", "default", "--timeout", String(SURVEY_TIMEOUT_S), "--title", title, "--option", "Done", "--option", "Other", body]);
      calls.push(call);
      await waitForCard(page, WINDOW_CARD, call, title);
      return call;
    };
    const answer = async (call, label) => {
      await page.click(`${WINDOW_CARD} .survey-option`);
      const outcome = await surveyOutcome(call, 10_000);
      if (!outcome || outcome.code !== 0) throw new Error(`${label}: a press on the card's first option left the survey ${JSON.stringify(outcome)}`);
      await page.waitForSelector(WINDOW_CARD, { hidden: true, timeout: 10_000 });
    };
    // A phase that throws is an interaction error: its unread legs stay
    // unread, a lock it left up is lifted, and the next phase still runs.
    const phase = async (fn) => {
      try {
        await fn();
      } catch (error) {
        report.interaction.push(`${report.step}: ${maskTokens(error?.stack ?? String(error))}`);
        await ctx.shot(`355-failure-${report.interaction.length}`).catch(() => {});
        if (await page.$(LOCK).catch(() => null)) {
          await unlock().catch((cause) => report.interaction.push(`unlock after "${report.step}": ${describe(cause)}`));
        }
      }
    };

    // Legs src, play, control, lock, unlock and map, in the editor.
    const editorLegs = async () => {
      step("open the document in the editor");
      await shell(["open", docPath]);
      const handle = await page.waitForSelector(EDITOR_VIDEO, { timeout: 30_000 });
      const mapHandle = await page.waitForSelector(EDITOR_MAP, { timeout: 30_000 });
      const video = tracked("editor video", handle);
      report.frames.editor = video;
      video.attributes = await attributesOf(handle);
      const mapAttributes = await attributesOf(mapHandle);
      report.frames.map = { attributes: mapAttributes, srcBefore: mapAttributes.src ?? null };
      leg("src", video.attributes.src === SRC_WANT
        ? passed(`editor: ${video.attributes.src}`)
        : failed(`the editor's frame src reads ${JSON.stringify(video.attributes.src)}, ${JSON.stringify(SRC_WANT)} wanted`));
      leg("map", mapAttributes.src === MAP_SRC_WANT
        ? passed(mapAttributes.src)
        : failed(`the map's src reads ${JSON.stringify(mapAttributes.src)}, ${JSON.stringify(MAP_SRC_WANT)} wanted`));

      step("wait for the editor's player");
      const noPlayer = await waitForPlayer(video);
      if (noPlayer) {
        leg("play", noPlayer);
        return;
      }

      step("start the video with a click at the frame's centre");
      let box = await handle.boundingBox();
      const viewport = page.viewport();
      if (box && viewport && (box.y < 0 || box.y + box.height > viewport.height)) {
        await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await sleep(500);
        box = await handle.boundingBox();
      }
      if (!box) throw new Error("the editor's video frame has no box to click");
      video.click = { t: Date.now(), x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      await page.mouse.click(video.click.x, video.click.y);
      const [started] = await watch([video], Date.now() + START_BOUND_MS, (taken) => advancingStretch(taken) !== null || taken.some(isAd));
      const stretch = advancingStretch(started);
      if (!stretch) {
        leg("play", environment(environmentIn(started) ?? `the click did not start playback: no ${ADVANCE_SPAN_MS} ms of advancing clock in ${START_BOUND_MS} ms`));
        return;
      }
      leg("play", passed(`clock ${stretch.from.video.time.toFixed(2)} to ${stretch.to.video.time.toFixed(2)} s over ${stretch.to.t - stretch.from.t} ms`));
      await ctx.shot("355-playing");

      step("control: no lock, nothing posted");
      const [unposted] = await watch([video], Date.now() + CONTROL_MS);
      if (leg("control", controlVerdict(unposted)).verdict !== "passed") return;

      step("lock while it plays");
      const before = unposted.filter((s) => s.video).at(-1);
      video.lockCommandT = Date.now();
      const coverT = await lockNow();
      video.coverT = coverT;
      const [locked] = await watch([video], coverT + PAUSE_WITHIN_MS + HOLD_MS + 500);
      const pause = leg("lock", pauseVerdict(locked, coverT, before));
      if (pause.verdict === "environment") return;

      step("unlock with the PIN");
      const held = pause.position ?? null;
      const unlockT = await unlock();
      video.unlockT = unlockT;
      const [after] = await watch([video], unlockT + HOLD_MS + 500);
      leg("unlock", holdVerdict(after, held));
      await ctx.shot("355-after-unlock");
    };

    // Legs autoplay, image and raw, in window-wide surveys; also the
    // renderer's half of src.
    const surveyLegs = async () => {
      step("autoplay control: the raw frame with no lock up");
      const control = await survey("Embed control", `A raw frame that asks to start by itself.\n\n${RAW_HTML}`);
      const controlFrame = tracked("raw control", await page.waitForSelector(SURVEY_RAW, { timeout: 15_000 }));
      report.frames.rawControl = controlFrame;
      controlFrame.attributes = await attributesOf(controlFrame.handle);
      const noControlPlayer = await waitForPlayer(controlFrame);
      if (noControlPlayer) {
        leg("autoplay", noControlPlayer);
      } else {
        const [ran] = await watch([controlFrame], Date.now() + START_BOUND_MS, (taken) => advancingStretch(readings(taken)) !== null || taken.some(isAd));
        const stretch = advancingStretch(readings(controlFrame.samples));
        leg("autoplay", stretch
          ? passed(`started by itself: clock ${stretch.from.video.time.toFixed(2)} to ${stretch.to.video.time.toFixed(2)} s`)
          : environment(environmentIn(ran) ?? `the raw frame did not start by itself in ${START_BOUND_MS} ms here, so whether the lock holds it off is unread`));
      }
      await ctx.shot("355-autoplay-control");
      await answer(control, "autoplay control");

      step("lock, then a survey arrives with both forms");
      const coverT = await lockNow();
      const both = await survey("Embed under the lock", `An image-link video and a raw frame that asks to start by itself.\n\n![](${WATCH_LINK})\n\n${RAW_HTML}`);
      const image = tracked("survey image link", await page.waitForSelector(SURVEY_IMAGE, { timeout: 15_000 }));
      const raw = tracked("survey raw", await page.waitForSelector(SURVEY_RAW, { timeout: 15_000 }));
      image.coverT = coverT;
      raw.coverT = coverT;
      report.frames.surveyImage = image;
      report.frames.surveyRaw = raw;
      image.attributes = await attributesOf(image.handle);
      raw.attributes = await attributesOf(raw.handle);
      const src = report.legs.src;
      if (image.attributes.src !== SRC_WANT) {
        const renderer = `the survey's image-link frame src reads ${JSON.stringify(image.attributes.src)}, ${JSON.stringify(SRC_WANT)} wanted`;
        leg("src", failed(src?.verdict === "failed" ? `${src.detail}; ${renderer}` : renderer));
      } else if (src?.verdict === "passed") {
        leg("src", passed(`${src.detail}; survey: ${image.attributes.src}`));
      }

      step("read both survey frames under the lock");
      const imagePlayer = await waitForPlayer(image);
      const rawPlayer = await waitForPlayer(raw);
      await watch([image, raw], Date.now() + UNDER_LOCK_WATCH_MS);
      const imageUnder = imagePlayer ?? neverStartedVerdict(image.samples, "under the lock");
      const rawUnder = rawPlayer ?? neverStartedVerdict(raw.samples, "under the lock");

      step("unlock and read both survey frames again");
      const unlockT = await unlock();
      image.unlockT = unlockT;
      raw.unlockT = unlockT;
      const [imageAfter, rawAfter] = await watch([image, raw], unlockT + HOLD_MS + 500);
      await ctx.shot("355-survey-after-unlock");
      const combine = (under, afterSamples, f) => {
        if (under.verdict !== "passed") return under;
        const afterUnlock = neverStartedVerdict(afterSamples, "after the unlock");
        if (afterUnlock.verdict !== "passed") return afterUnlock;
        return passed(`${under.detail}; ${afterUnlock.detail}; src ${f.attributes.src}`);
      };
      leg("image", combine(imageUnder, imageAfter, image));
      const rawVerdict = combine(rawUnder, rawAfter, raw);
      const autoplay = report.legs.autoplay;
      leg("raw", autoplay?.verdict === "passed"
        ? rawVerdict
        : { verdict: "unread", detail: `its control did not hold (${autoplay?.detail ?? "not read"}); it read ${rawVerdict.verdict}: ${rawVerdict.detail}` });
      await answer(both, "survey under the lock");
    };

    try {
      step("load the window with the lock state served");
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.waitForFunction(() => performance.getEntriesByType("resource")
        .some((e) => e.name.includes("/api/screensaver/state") && e.responseEnd > 0), { timeout: 30_000 });
      await settle(page);
      await page.bringToFront();
      windowId = await checkWindowId(page);
      if (!windowId) throw new Error("the check page has no window id");
      await ctx.waitWindowLive(windowId);

      step("seed the document and open a terminal for the surveys");
      mkdirSync(absolute);
      writeFileSync(join(absolute, "video.md"), DOC_TEXT);
      await openAttachedTerminal(ctx, page, cs, windowId, terminalName, ["--command", "exec cat"]);

      await phase(editorLegs);
      await phase(surveyLegs);

      step("read the map's src again");
      const map = await page.$(EDITOR_MAP);
      if (!map) throw new Error("the map frame is gone from the editor at the end");
      const mapAfter = await map.evaluate((el) => el.getAttribute("src"));
      if (report.frames.map) report.frames.map.srcAfter = mapAfter;
      if (report.legs.map?.verdict === "passed" && mapAfter !== MAP_SRC_WANT) {
        leg("map", failed(`the map's src read ${JSON.stringify(mapAfter)} at the end, ${JSON.stringify(MAP_SRC_WANT)} at the start`));
      }
    } catch (error) {
      report.interaction.push(`${report.step}: ${maskTokens(error?.stack ?? String(error))}`);
      await ctx.shot("355-failure").catch(() => {});
    } finally {
      step("cleanup");
      if (await page.$(LOCK).catch(() => null)) await unlock().catch((error) => report.cleanupErrors.push(`unlock: ${describe(error)}`));
      await answerOpenSurveys(page, calls).catch((error) => report.cleanupErrors.push(`surveys: ${describe(error)}`));
      try {
        const active = await page.$eval(".pane .tabs .tab.active", (el) => el.getAttribute("title")).catch(() => null);
        if (active === docPath) await closeActiveTab(page, "355 cleanup: the document");
        await closeEveryTerminal(page, "355 cleanup", token);
      } catch (error) {
        report.cleanupErrors.push(`tabs: ${describe(error)}`);
      }
      await cdp.send("Fetch.disable").catch(() => {});
      await cdp.detach().catch(() => {});
      rmSync(absolute, { recursive: true, force: true });
      report.verifications = lock.verifications;
      save();
    }

    const order = ["src", "play", "control", "lock", "unlock", "autoplay", "image", "raw", "map"];
    for (const name of order) report.legs[name] ??= { verdict: "unread", detail: "the leg did not run" };
    const lines = (kind) => order.filter((name) => report.legs[name].verdict === kind).map((name) => `${name}: ${report.legs[name].detail}`);
    const failures = lines("failed");
    const other = [
      ...lines("environment"),
      ...lines("unread"),
      ...report.interaction.map((line) => line.split("\n")[0]),
      ...report.cleanupErrors.map((line) => `cleanup: ${line}`),
    ];
    report.summary = { failures, other };
    save();
    if (failures.length) {
      throw Object.assign(new Error(`a YouTube embed under the screen lock: ${[...failures, ...other].join("; ")}`), { smokeDetails: report.legs });
    }
    if (other.length) {
      throw environmentError(`a YouTube embed under the screen lock could not be read: ${other.join("; ")}`, report.legs);
    }
    return report.legs;
  },
};
