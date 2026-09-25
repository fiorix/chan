import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The server half of the terminal protocol, read from the Rust route. The
// client half is driven by mounted TerminalTab tests: the resume cursor in
// TerminalTab.snapshot.test.ts, binary output in
// TerminalTab.renderer.svelte.test.ts, the size frames in
// TerminalTab.fit.test.ts and the generated replies in
// TerminalTab.replies.test.ts.
const route = readFileSync("../../../crates/chan-server/src/routes/terminal.rs", "utf8");

describe("terminal protocol invariants", () => {
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

  test("the server sends PTY output and replay as binary frames", () => {
    expect(route).toMatch(/SessionEvent::Output\(data\)[\s\S]*?Message::binary\(data\)/);
    expect(route).toMatch(/socket\.send\(Message::binary\(chunk\.clone\(\)\)\)/);
  });

  test("the server applies the client's PtySize frames", () => {
    expect(route).toMatch(/ClientFrame::Resize \{ cols, rows \}[\s\S]*?session\.resize\(pty_size\(Some\(cols\), Some\(rows\)\)\)/);
  });
});
