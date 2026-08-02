import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import tab from "../components/TerminalTab.svelte?raw";
import session from "./session.ts?raw";

const route = readFileSync("../../../crates/chan-server/src/routes/terminal.rs", "utf8");

describe("terminal protocol invariants", () => {
  test("reattach defaults to a full replay; a cursor rides only with a generation", () => {
    // The default `since` is still 0 (a full replay into a fresh xterm). A byte
    // cursor is sent either from a validated scrollback-snapshot cache hit or
    // from the in-memory cursor of an already-mounted xterm, always paired with
    // the session generation the server gates it against. A bare per-tab cursor
    // -- the old "last line after a split" bug -- never goes on the wire.
    expect(session).toContain(
      "String(Math.max(0, Math.floor(opts.since ?? 0)))",
    );
    expect(session).toContain("if (opts.generation != null)");
    // Fresh-xterm resume originates from the snapshot cache; live reconnect
    // originates from the mounted xterm's in-memory cursor.
    expect(tab).toContain("readTerminalSnapshot");
    expect(tab).toContain("const liveResumeSince");
  });

  test("server attach prelude sends control, binary replay, alt-screen prelude, then ready", () => {
    const prelude = route.match(/async fn send_attach_prelude[\s\S]*?\n}\n\nfn terminal_cwd_payload/)?.[0];
    expect(prelude).toBeTruthy();
    const sessionFrame = prelude!.indexOf("session_frame(session)");
    const replay = prelude!.indexOf("for chunk in &session.replay");
    const altScreen = prelude!.indexOf("ALT_SCREEN_ATTACH_PRELUDE");
    const ready = prelude!.indexOf("ServerFrame::Ready");

    expect(sessionFrame).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThan(sessionFrame);
    expect(altScreen).toBeGreaterThan(replay);
    expect(ready).toBeGreaterThan(altScreen);
    expect(route).toMatch(
      /fn session_frame\(session: &AttachHandle\)[\s\S]*?SubmitAgent::derive\([\s\S]*?session\.spawn_command\(\)[\s\S]*?session\.spawn_env\("CHAN_AGENT"\)[\s\S]*?ServerFrame::Session/,
    );
  });

  test("PTY output remains binary on both sides of the websocket", () => {
    expect(route).toMatch(/SessionEvent::Output\(data\)[\s\S]*?Message::binary\(data\)/);
    expect(route).toMatch(/socket\.send\(Message::binary\(chunk\.clone\(\)\)\)/);
    expect(tab).toContain('ws.binaryType = "arraybuffer"');
    expect(tab).toContain("terminalMessageBytes(event.data)");
    expect(tab).not.toMatch(/term\?\.write\(String\(/);
  });

  test("client sends initial and resize-observed PtySize frames", () => {
    expect(tab).toMatch(/ws\.onopen = \(\) => \{[\s\S]*?send\(\{ type: "resize", cols: term\.cols, rows: term\.rows \}\)/);
    expect(tab).toMatch(
      /term\.onResize\(\(\{ cols, rows \}\) => \{\s*send\(\{ type: "resize", cols, rows \}\);[\s\S]{1,500}secretMasker\?\.scanAll\(\);[\s\S]{1,40}\}\)/,
    );
    expect(route).toMatch(/ClientFrame::Resize \{ cols, rows \}[\s\S]*?session\.resize\(pty_size\(Some\(cols\), Some\(rows\)\)\)/);
  });

  test("terminal-generated replies bypass broadcast and are not replay-gated", () => {
    expect(tab).toContain("routeXtermData(data, ptyWrites, sendInput, sendUserInput)");
    expect(tab).not.toContain("replayingReattach");
    expect(tab).not.toContain("clearReplayWhenDrained");
  });
});
