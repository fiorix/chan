import { describe, expect, test } from "vitest";
import { renderTable } from "./shortcuts";

describe("shortcut table", () => {
  test("advertises Command launcher as Ctrl+Alt+K on web and Cmd+K on native mac", () => {
    expect(renderTable("web", "mac")).toMatch(/^Command launcher\s+Ctrl\+Alt\+K/m);
    expect(renderTable("native", "mac")).toMatch(/^Command launcher\s+Cmd\+K/m);
  });

  test("advertises Settings on comma", () => {
    expect(renderTable("web", "mac")).toMatch(/^Settings\s+Cmd\+,/m);
    expect(renderTable("native", "mac")).toMatch(/^Settings\s+Cmd\+,/m);
    expect(renderTable("web", "linux")).toMatch(/^Settings\s+Ctrl\+,/m);
    expect(renderTable("native", "windows")).toMatch(/^Settings\s+Ctrl\+,/m);
  });

  test("advertises Search as Cmd+Shift+S on macOS and Ctrl+Alt+S elsewhere", () => {
    expect(renderTable("web", "mac")).toMatch(
      /^Search\s+Cmd\+Shift\+S\s+\(Ctrl\+Alt\+S on Linux \/ Windows\)/m,
    );
    expect(renderTable("native", "mac")).toMatch(/^Search\s+Cmd\+Shift\+S/m);
    expect(renderTable("web", "linux")).toMatch(/^Search\s+Ctrl\+Alt\+S/m);
    expect(renderTable("native", "windows")).toMatch(/^Search\s+Ctrl\+Alt\+S/m);
  });

  // "New terminal" is a direct chord so power users can spawn a terminal
  // without entering Pane Mode. Cmd+T on the macOS desktop; Ctrl+Shift+T on
  // web (and the off-mac desktop) after the no-defaults round: a desktop-first
  // literal, browser clients rebind.
  test("advertises New terminal under Ctrl+Shift+T (web mac)", () => {
    const table = renderTable("web", "mac");
    expect(table).toMatch(/^New terminal +Ctrl\+Shift\+T\b/m);
  });

  test("advertises New terminal under Cmd+T (native mac)", () => {
    const table = renderTable("native", "mac");
    expect(table).toMatch(/^New terminal +Cmd\+T\b/m);
  });

  // The sibling label `Team Work` must not match the bare-Terminal
  // regex; these guards anchor to that exact word to catch an
  // accidental rename or duplicate entry.
  test("does not advertise a bare 'Terminal' row (web)", () => {
    const table = renderTable("web", "mac");
    expect(table).not.toMatch(/^Terminal +Cmd\+Alt\+T\b/m);
    expect(table).not.toMatch(/^Terminal +Cmd\+`\b/m);
    expect(table).not.toMatch(/^Terminal +Cmd\+T\b/m);
  });

  test("does not advertise a bare 'Terminal' row (native)", () => {
    const table = renderTable("native", "mac");
    expect(table).not.toMatch(/^Terminal +Cmd\+T\b/m);
    expect(table).not.toMatch(/^Terminal +Cmd\+Alt\+T\b/m);
  });

  test("advertises Hybrid Nav (Cmd+.) as the canonical spawn surface", () => {
    // Mod+. avoids the browser-reserved Mod+, (Settings) and is
    // not reserved by any browser, surviving both web + native.
    const web = renderTable("web", "mac");
    const native = renderTable("native", "mac");
    expect(web).toMatch(/^Hybrid Nav\s+Cmd\+\.$/m);
    expect(native).toMatch(/^Hybrid Nav\s+Cmd\+\.$/m);
  });

  test("advertises pane side flip on Ctrl+`", () => {
    expect(renderTable("web", "mac")).toMatch(/^Flip pane side\s+Ctrl\+`/m);
    expect(renderTable("native", "mac")).toMatch(/^Flip pane side\s+Ctrl\+`/m);
  });

  // No-defaults rebind: Cmd+W is the macOS primary, Ctrl+Shift+W the
  // Linux / Windows desktop primary; Ctrl+D stays the alternate on web
  // and the off-mac desktop.
  test("close-tab: Ctrl+D on web, Cmd+W on native mac, Ctrl+Shift+W off-mac native", () => {
    const web = renderTable("web", "mac");
    const native = renderTable("native", "mac");
    const nativeLinux = renderTable("native", "linux");
    expect(web).toMatch(/^Close tab\s+Ctrl\+D/m);
    expect(native).toMatch(/^Close tab\s+Cmd\+W/m);
    expect(nativeLinux).toMatch(/^Close tab\s+Ctrl\+Shift\+W/m);
  });

  // Reopen closed tab rebinds off plain Ctrl+Shift+T (now the off-mac
  // New-terminal chord and the browser's own reopen): Cmd+Shift+T on mac
  // native, Ctrl+Alt+Shift+T on web.
  test("reopen-closed-tab: Ctrl+Alt+Shift+T on web, Cmd+Shift+T on native mac", () => {
    expect(renderTable("web", "mac")).toMatch(
      /^Reopen closed tab\s+Ctrl\+Alt\+Shift\+T/m,
    );
    expect(renderTable("native", "mac")).toMatch(
      /^Reopen closed tab\s+Cmd\+Shift\+T/m,
    );
  });

  // Close window is native-only: Cmd+Shift+W on macOS (Cmd+W closes the
  // tab), Ctrl+Alt+W off macOS (Ctrl+Shift+W is tab close there).
  test("close-window is native-only, Cmd+Shift+W on mac, Ctrl+Alt+W off-mac", () => {
    expect(renderTable("native", "mac")).toMatch(/^Close window\s+Cmd\+Shift\+W/m);
    expect(renderTable("native", "linux")).toMatch(/^Close window\s+Ctrl\+Alt\+W/m);
    expect(renderTable("web", "mac")).not.toMatch(/^Close window\b/m);
  });

  // Pane nav splits per platform: web uses Alt+[/] because Cmd+[/]
  // is browser back/forward; desktop-native keeps Cmd+[/].
  test("advertises pane nav: web Alt+[/], native Cmd+[/]", () => {
    const web = renderTable("web", "mac");
    const native = renderTable("native", "mac");
    expect(web).toMatch(/^Previous pane\s+Alt\+\[/m);
    expect(web).toMatch(/^Next pane\s+Alt\+\]/m);
    expect(native).toMatch(/^Previous pane\s+Cmd\+\[/m);
    expect(native).toMatch(/^Next pane\s+Cmd\+\]/m);
  });

  // No-defaults cleanup: these commands lost their built-in chord and no
  // longer render a table row (each stays assignable in the config UI).
  test("dropped-default commands have no table row", () => {
    const dropped = [
      "Flip focused Hybrid",
      "Team Work",
      "Toggle broadcast to all terminals",
      "File browser",
      "Graph",
      "New draft",
      "Lock screen",
      "Dashboard",
      "Flip Hybrid",
      "Close all tabs in pane",
      "Kill pane",
      "Close empty pane",
    ];
    for (const platform of ["web", "native"] as const) {
      const table = renderTable(platform, "mac");
      for (const label of dropped) {
        expect(table, `${label} (${platform})`).not.toMatch(
          new RegExp(`^${label}\\s`, "m"),
        );
      }
    }
  });

  test("advertises editor Bold (Cmd+B) and Italic (Cmd+I)", () => {
    expect(renderTable("web", "mac")).toMatch(/^Bold\s+Cmd\+B/m);
    expect(renderTable("web", "mac")).toMatch(/^Italic\s+Cmd\+I/m);
    expect(renderTable("native", "mac")).toMatch(/^Bold\s+Cmd\+B/m);
    expect(renderTable("native", "mac")).toMatch(/^Italic\s+Cmd\+I/m);
  });

  // Web uses Ctrl+Alt+/ because Ctrl+/ is claimed by terminal/editor surfaces.
  // Native split-bottom remains Cmd+Shift+/ because 1Password registers Cmd+\
  // as a system-wide macOS hotkey before chan's webview receives it.
  test("advertises split chords on web and native", () => {
    const web = renderTable("web", "mac");
    const native = renderTable("native", "mac");
    expect(web).toMatch(/^Split right\s+Ctrl\+Alt\+\//m);
    expect(web).toMatch(/^Split bottom\s+Ctrl\+Alt\+\?/m);
    expect(native).toMatch(/^Split right\s+Cmd\+\//m);
    expect(native).toMatch(/^Split bottom\s+Cmd\+Shift\+\//m);
  });

  // `chan open --help` prints this table verbatim (the Rust workspace pins
  // clap without `wrap_help`), so the capped form has a hard column budget.
  test("maxWidth moves an oversized note onto its own line", () => {
    const capped = renderTable("web", "mac", 74);
    for (const line of capped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(74);
    }
    // The note survives the move; it is not truncated away.
    expect(capped).toMatch(/^Search\s+Cmd\+Shift\+S$/m);
    expect(capped).toMatch(/^\s+\(Ctrl\+Alt\+S on Linux \/ Windows\)$/m);
  });

  test("without maxWidth every note stays inline", () => {
    const plain = renderTable("web", "mac");
    expect(plain).toMatch(/^Search\s+Cmd\+Shift\+S\s+\(Ctrl\+Alt\+S on Linux/m);
  });

});
