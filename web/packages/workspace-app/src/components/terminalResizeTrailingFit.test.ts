import { describe, expect, test } from "vitest";
import terminal from "./TerminalTab.svelte?raw";

// A trailing-edge debounced fit converges on the steady-state size
// 120ms after the last observed resize, covering the case where the
// FIRST resize transition's ResizeObserver fire is missed/swallowed
// (which would otherwise leave the terminal at the leading-edge size).
// The leading-edge rAF stays for snappy initial response.

describe("trailing-edge fit converges after resize", () => {
  test("queueFit schedules both the leading rAF fit AND the trailing fit", () => {
    expect(terminal).toMatch(
      /function queueFit\(\): void \{[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?runTerminalFit\(fit, term[\s\S]*?trailingFit\.schedule\(\);/,
    );
  });

  test("trailing fit is owned by the resize helper", () => {
    expect(terminal).toContain("createTrailingFitScheduler");
    expect(terminal).toMatch(/const trailingFit = createTrailingFitScheduler\(\(\) => \{[\s\S]*?runTerminalFit\(fit, term/);
  });

  test("teardown clears the trailing-fit timer (no race against dispose)", () => {
    expect(terminal).toMatch(
      /function teardown\(\): void \{[\s\S]*?trailingFit\.clear\(\);/,
    );
  });

  test("ResizeObserver still wired to queueFit (leading-edge path preserved)", () => {
    expect(terminal).toMatch(
      /resizeObserver = new ResizeObserver\(queueFit\);[\s\S]*?resizeObserver\.observe\(host\);/,
    );
  });

  test("mount fits synchronously before dialing the PTY", () => {
    const mountPath = terminal.match(
      /term\.onResize\([\s\S]*?void connect\(\);/,
    )?.[0];
    expect(mountPath).toBeDefined();
    expect(mountPath).toMatch(
      /resizeObserver\.observe\(host\);[\s\S]*?runTerminalFit\(fit, term[\s\S]*?void connect\(\);/,
    );
    expect(mountPath).not.toMatch(
      /if\s*\([^)]*runTerminalFit\(fit, term/,
    );
    expect(mountPath).not.toContain("queueFit();");
  });

  test("rationale comment explains the leading vs trailing split + idempotence", () => {
    expect(terminal).toMatch(/trailing-edge fit/i);
    expect(terminal).toMatch(/Idempotent[\s\S]{1,80}size hasn't drifted/i);
  });
});

describe("PTY resize propagation preserved", () => {
  test("xterm onResize still sends `{ type: 'resize', cols, rows }` to chan-server", () => {
    // The resize frame is the handler's FIRST statement: the secret-mask
    // rescan (cols-change only) must not delay the notification.
    expect(terminal).toMatch(
      /term\.onResize\(\(\{ cols, rows \}\) => \{\s*send\(\{ type: "resize", cols, rows \}\);[\s\S]{1,500}secretMasker\?\.scanAll\(\);[\s\S]{1,40}\}\);/,
    );
  });

  test("WebSocket open handler still sends the initial resize frame", () => {
    expect(terminal).toMatch(
      /if \(term\) send\(\{ type: "resize", cols: term\.cols, rows: term\.rows \}\);/,
    );
  });

  test("server resize frames update only hidden terminal instances", () => {
    expect(terminal).toMatch(
      /\| \{ type: "resize"; cols: number; rows: number \}/,
    );
    expect(terminal).toMatch(
      /frame\.type === "resize" \|\| frame\.type === "resize_other"/,
    );
    expect(terminal).toMatch(
      /!active && term && \(term\.cols !== frame\.cols \|\| term\.rows !== frame\.rows\)[\s\S]*?term\.resize\(frame\.cols, frame\.rows\)/,
    );
  });
});
