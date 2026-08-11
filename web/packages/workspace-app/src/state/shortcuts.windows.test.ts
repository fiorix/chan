import { describe, expect, test } from "vitest";
import {
  formatChord,
  osChord,
  type Platform,
  SHORTCUTS,
} from "./shortcuts";

// Confirm the Windows shortcut set is Ctrl-based and
// Linux-like -- no chord LABEL should render "Cmd" under Windows
// (Windows keyboards have no Command key; Win-key-as-Cmd is ruled out).

function windowsLabels(platform: Platform): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const s of SHORTCUTS) {
    const chord = osChord(s, platform, "windows");
    if (!chord) continue;
    out.push({ id: s.id, label: formatChord(chord, "windows") });
  }
  return out;
}

describe("Windows shortcut labels are Ctrl-based", () => {
  test("Mod renders Ctrl, not Cmd (web + native)", () => {
    for (const platform of ["web", "native"] as Platform[]) {
      const modBased = windowsLabels(platform).filter((x) =>
        SHORTCUTS.find((s) => s.id === x.id)?.[platform]?.includes("Mod"),
      );
      // Every Mod-token chord must surface as Ctrl on Windows.
      for (const { id, label } of modBased) {
        expect(label, `${id} (${platform})`).not.toContain("Cmd");
        expect(label, `${id} (${platform})`).toContain("Ctrl");
      }
    }
  });

  test("the shell-colliding + Win-key chords diverge on Windows", () => {
    const pick = (id: string, platform: Platform) =>
      formatChord(
        osChord(SHORTCUTS.find((s) => s.id === id)!, platform, "windows")!,
        "windows",
      );
    // Shell / app collisions → Ctrl+Shift, freeing bare Ctrl+C (SIGINT) and
    // Ctrl+R (reverse-search).
    expect(pick("app.window.reload", "native")).toBe("Ctrl+Shift+R");
    expect(pick("app.launcher.toggle", "native")).toBe("Ctrl+Alt+K");
    expect(pick("app.launcher.toggle", "web")).toBe("Ctrl+Alt+K");
    expect(pick("app.settings.open", "native")).toBe("Ctrl+,");
    expect(pick("app.search.toggle", "native")).toBe("Ctrl+Alt+S");
    expect(pick("app.search.toggle", "web")).toBe("Ctrl+Alt+S");
    expect(pick("terminal.copy", "native")).toBe("Ctrl+Shift+C");
    expect(pick("terminal.paste", "native")).toBe("Ctrl+Shift+V");
    // Rich Prompt: Win key ruled out → Ctrl+Shift+P on native and web alike.
    expect(pick("terminal.richPrompt", "native")).toBe("Ctrl+Shift+P");
    expect(pick("terminal.richPrompt", "web")).toBe("Ctrl+Shift+P");
    // No-defaults rebinds: tab / terminal / window chords diverge on the
    // Windows desktop. Close tab takes Ctrl+Shift+W (plain Ctrl+W stays
    // readline delete-word in a shell); Ctrl+D stays the alternate.
    // Window close moves to Ctrl+Alt+W so the two never share a chord.
    expect(pick("app.window.close", "native")).toBe("Ctrl+Alt+W");
    expect(pick("app.terminal.toggle", "native")).toBe("Ctrl+Shift+T");
    expect(pick("app.tab.reopenClosed", "native")).toBe("Ctrl+Alt+Shift+T");
    expect(pick("app.tab.close", "native")).toBe("Ctrl+Shift+W");
  });

  test("native (desktop) Windows has ZERO Cmd labels", () => {
    const offenders = windowsLabels("native").filter((x) =>
      x.label.includes("Cmd"),
    );
    expect(offenders).toEqual([]);
  });

  test("no web Cmd labels remain after the no-defaults rebinds", () => {
    // The Cmd+Alt+<key> Mac-web spawn fallbacks are gone: Team Work and File
    // browser lost their defaults, and New terminal's web chord is now the
    // literal Ctrl+Shift+T (desktop-first). So no web chord renders a Cmd
    // label on Windows.
    const webCmd = windowsLabels("web")
      .filter((x) => x.label.includes("Cmd"))
      .map((x) => x.id)
      .sort();
    expect(webCmd).toEqual([]);
  });
});
