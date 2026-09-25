import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The server half of the terminal protocol, read from the Rust route, only
// where no Rust test pins it. Rust pins the rest in routes/terminal.rs:
// reconnect_after_an_attach_raced_by_output_loses_no_bytes reads replay and
// live output only from binary frames and needs the replay before ready, and
// the session_frame_* tests pin the submit agent the session frame derives.
// The client half is driven by mounted TerminalTab tests: the resume cursor in
// TerminalTab.snapshot.test.ts, binary output in
// TerminalTab.renderer.svelte.test.ts, the size frames in
// TerminalTab.fit.test.ts and the generated replies in
// TerminalTab.replies.test.ts.
// Survivor until a Rust test pins it: the prelude sends the session frame first and the alt-screen prelude between the replay and ready, and a Resize frame resizes the PTY.
const route = readFileSync("../../../crates/chan-server/src/routes/terminal.rs", "utf8");

describe("terminal protocol invariants", () => {
  test("the attach prelude sends the session frame first, and the alt-screen prelude after the replay and before ready", () => {
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
  });

  test("the server applies the client's PtySize frames", () => {
    expect(route).toMatch(/ClientFrame::Resize \{ cols, rows \}[\s\S]*?session\.resize\(pty_size\(Some\(cols\), Some\(rows\)\)\)/);
  });
});
