import type { IBufferRange, Terminal as XtermTerminal } from "@xterm/xterm";

import { openExternalUrl } from "../editor/external_links";
import { copyTextToClipboard, setTransientStatus, ui } from "../state/store.svelte";
import { editorRefusalForWindow, openTerminalFileInEditor, serverHostName } from "./linkActions";
import { classifyTerminalLink, resolveTerminalPath, type TerminalLinkTarget } from "./linkTarget";

// The menu on a link a terminal underlines, apart from its markup.
//
// A plain click on a link opens a menu at the pointer that shows the link's
// real target (`linkTarget.ts`): "Open in browser" and "Copy link" for a web
// link, "Open in editor" and "Copy path" for a file link. Ctrl or Cmd with
// the click runs the first entry with no menu. Each backend decides what a
// link click is (the ghostty widget in its `onLinkActivate`, xterm.js through
// `xtermLinkHandlers` below) and hands it to `TerminalLinkMenu.onLink`. The
// terminal tab keeps the markup, the menu's place and the watcher that closes
// it when the link's cells change or move.

/// A link's cells, 0-based, rows absolute (0 the oldest history row), both
/// ends included.
export type LinkRange = { start: { x: number; y: number }; end: { x: number; y: number } };

export type LinkMenuState = {
  link: TerminalLinkTarget;
  range: LinkRange;
  /// The link's rows and their place on the screen when the menu opened.
  anchor: string | null;
  /// The cwd replies seen before the click asked for a fresh one.
  cwdSince: number;
  editorBusy: boolean;
  /// Why "Open in editor" is off: refused before the menu showed, or by the
  /// press.
  editorRefusal: string | null;
};

/// What the terminal tab gives the menu: its terminal and its tab menu.
export type LinkMenuHost = {
  /// Whether a cover over the window holds the input.
  blocked(): boolean;
  /// Ask the server for the shell's directory (a `cwd` frame).
  requestCwd(): void;
  /// The shell's directory as last reported, absolute.
  cwd(): string | null;
  /// The link's rows and where the viewport shows them.
  anchorKey(range: LinkRange): string | null;
  /// Open the tab's menu bubble as the link menu, at the click.
  open(at: { x: number; y: number }): void;
  /// Close the tab's menu bubble if it shows the link menu.
  close(): void;
  focusTerminal(): void;
};

const CWD_WAIT_MS = 1500;

export class TerminalLinkMenu {
  menu = $state<LinkMenuState | null>(null);
  #cwdReplies = 0;
  #cwdWaiters: Array<() => void> = [];
  private readonly host: LinkMenuHost;

  constructor(host: LinkMenuHost) {
    this.host = host;
  }

  /// A `cwd` frame arrived.
  noteCwd(): void {
    this.#cwdReplies += 1;
    for (const wake of this.#cwdWaiters.splice(0)) wake();
  }

  /// The shell's directory as the server read it after the click: the reply
  /// the click asked for, or the last one when none comes in time.
  async #cwdAfter(since: number): Promise<string | null> {
    if (this.#cwdReplies <= since) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#cwdWaiters = this.#cwdWaiters.filter((wake) => wake !== done);
          resolve();
        };
        const timer = setTimeout(done, CWD_WAIT_MS);
        this.#cwdWaiters.push(done);
      });
    }
    return this.host.cwd();
  }

  /// A link click: open the menu, or with Ctrl or Cmd run its first entry.
  async onLink(target: string, range: LinkRange, event: MouseEvent): Promise<void> {
    if (this.host.blocked()) return;
    const link = await classifyTerminalLink(target, serverHostName);
    const cwdSince = this.#cwdReplies;
    // Only a relative path reads the shell's directory.
    if (link.kind === "file" && link.relative) this.host.requestCwd();
    const editorRefusal = link.kind === "file" ? (link.refusal ?? editorRefusalForWindow()) : null;
    if (event.ctrlKey || event.metaKey) {
      const refusal = link.kind === "web" ? link.refusal : (editorRefusal ?? (await this.#openFile(link, cwdSince)));
      if (refusal) {
        ui.status = `open failed: ${refusal}`;
        ui.statusKind = "persistent";
      } else if (link.kind === "web") {
        void openExternalUrl(link.url);
      }
      return;
    }
    this.menu = { link, range, anchor: this.host.anchorKey(range), cwdSince, editorBusy: false, editorRefusal };
    this.host.open({ x: event.clientX, y: event.clientY });
  }

  /// Open a file link as `cs open` in the terminal's shell would: a relative
  /// path against the shell's directory. Resolves to the refusal, or null
  /// once the open is on its way.
  async #openFile(link: Extract<TerminalLinkTarget, { kind: "file" }>, cwdSince: number): Promise<string | null> {
    let path = link.path;
    if (link.relative) {
      const cwd = await this.#cwdAfter(cwdSince);
      if (!cwd) return "the shell's directory is unknown";
      path = resolveTerminalPath(path, cwd);
    }
    return openTerminalFileInEditor(path);
  }

  close(refocus: boolean): void {
    this.host.close();
    this.menu = null;
    if (refocus) this.host.focusTerminal();
  }

  /// Whether the menu no longer points at what is on the screen.
  stale(): boolean {
    const menu = this.menu;
    return menu !== null && this.host.anchorKey(menu.range) !== menu.anchor;
  }

  openInBrowser(): void {
    const menu = this.menu;
    this.close(true);
    if (menu?.link.kind === "web" && !menu.link.refusal) void openExternalUrl(menu.link.url);
  }

  async openInEditor(): Promise<void> {
    const menu = this.menu;
    if (!menu || menu.link.kind !== "file" || menu.editorBusy || menu.editorRefusal) return;
    menu.editorBusy = true;
    const refusal = await this.#openFile(menu.link, menu.cwdSince);
    menu.editorBusy = false;
    if (this.menu !== menu) return;
    if (refusal) menu.editorRefusal = refusal;
    // The keyboard goes back to the terminal: an open routed to another
    // window or revealed in the file browser takes none here, and an editor
    // tab that opens takes it as it arrives.
    else this.close(true);
  }

  async copyTarget(): Promise<void> {
    const menu = this.menu;
    if (!menu) return;
    this.close(true);
    const web = menu.link.kind === "web";
    await copyTextToClipboard(menu.link.kind === "web" ? menu.link.url : menu.link.path, {
      onSuccess: () => setTransientStatus(web ? "Copied link" : "Copied path"),
      onError: (msg) => {
        ui.status = `copy failed: ${msg}`;
        ui.statusKind = "persistent";
      },
    });
  }
}

type XtermLinkTerminal = Pick<XtermTerminal, "hasSelection"> & {
  modes: Pick<XtermTerminal["modes"], "mouseTrackingMode">;
};

/// The link hooks of an xterm.js terminal, both reporting a link click to
/// `onLink` with a 0-based range: `linkHandler` for the terminal's
/// `linkHandler` option (OSC 8, every scheme, since the menu judges the
/// target) and `webLink` for `WebLinksAddon` (URLs in the text).
///
/// xterm.js activates a link on the release that ends a press on it. A drag
/// that selected, a double click's second release and a press sent to a
/// program tracking the mouse are not link clicks; Shift keeps a press from
/// the program (`selectionBypass.ts`).
export function xtermLinkHandlers(
  terminal: () => XtermLinkTerminal | null,
  onLink: (target: string, range: LinkRange, event: MouseEvent) => void,
) {
  const report = (event: MouseEvent, target: string, range: IBufferRange): void => {
    const t = terminal();
    if (!t || event.button !== 0 || event.detail > 1 || t.hasSelection()) return;
    if (t.modes.mouseTrackingMode !== "none" && !event.shiftKey) return;
    onLink(target, {
      start: { x: range.start.x - 1, y: range.start.y - 1 },
      end: { x: range.end.x - 1, y: range.end.y - 1 },
    }, event);
  };
  // `WebLinksAddon` hands its handler no range. Its hover callback passes the
  // link's own range, the 1-based buffer range the activation would carry
  // (typed there as a viewport range), so the click takes the range the last
  // hover reported for the same URL.
  let hovered: { uri: string; range: IBufferRange } | null = null;
  return {
    linkHandler: { allowNonHttpProtocols: true, activate: report },
    webLink: {
      handler: (event: MouseEvent, uri: string): void => {
        if (hovered?.uri === uri) report(event, uri, hovered.range);
      },
      options: {
        hover: (_event: MouseEvent, uri: string, range: IBufferRange): void => {
          hovered = { uri, range };
        },
        leave: (): void => {
          hovered = null;
        },
      },
    },
  };
}
