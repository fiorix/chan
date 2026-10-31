export type BrowserCommand =
  | "previous" | "next" | "first" | "last" | "pagePrevious" | "pageNext"
  | "parent" | "child" | "open" | "rename" | "copy" | "cut" | "paste"
  | "delete" | "new" | "upload" | "download" | "copyPath" | "terminal"
  | "graph" | "menu" | "preview" | "filter" | "selectMode" | "toggle"
  | "selectAll" | "clear";

export const browserBindings: Partial<Record<BrowserCommand, { standard: string; vim?: string }>> = {
  previous: { standard: "Up", vim: "k" }, next: { standard: "Down", vim: "j" },
  parent: { standard: "Left", vim: "h" }, child: { standard: "Right", vim: "l" },
  first: { standard: "Home", vim: "gg" }, last: { standard: "End", vim: "G" },
  pagePrevious: { standard: "PageUp" }, pageNext: { standard: "PageDown" },
  open: { standard: "Enter" }, rename: { standard: "F2" },
  copy: { standard: "Mod+C", vim: "y" }, cut: { standard: "Mod+X", vim: "x" },
  paste: { standard: "Mod+V", vim: "p" }, delete: { standard: "Delete" },
  menu: { standard: "Shift+F10" }, preview: { standard: "Mod+Y" },
  filter: { standard: "/" }, selectMode: { standard: "F8", vim: "v" },
  toggle: { standard: "Space" }, selectAll: { standard: "Mod+A" },
  clear: { standard: "Escape" },
};

export function browserCommandChord(command: BrowserCommand, vim: boolean): string {
  const binding = browserBindings[command];
  return (vim && binding?.vim) || binding?.standard || "";
}

export function browserKeyCommand(e: KeyboardEvent, vim: boolean, prefix: string): BrowserCommand | null {
  if (e.isComposing || e.defaultPrevented) return null;
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) return "menu";
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const modified: Record<string, BrowserCommand> = { a: "selectAll", c: "copy", x: "cut", v: "paste", y: "preview" };
    if (modified[e.key.toLowerCase()]) return modified[e.key.toLowerCase()];
  }
  if (e.altKey || e.metaKey || (e.ctrlKey && !["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key))) return null;
  const standard: Record<string, BrowserCommand> = {
    ArrowUp: "previous", ArrowDown: "next", ArrowLeft: "parent", ArrowRight: "child",
    Home: "first", End: "last", PageUp: "pagePrevious", PageDown: "pageNext",
    Enter: "open", F2: "rename", F8: "selectMode", " ": "toggle",
    Delete: "delete", Backspace: "delete", Escape: "clear", "/": "filter",
  };
  if (standard[e.key]) return standard[e.key];
  if (!vim || e.ctrlKey) return null;
  if (e.key === "g" && prefix === "g") return "first";
  const vi: Record<string, BrowserCommand> = {
    h: "parent", j: "next", J: "next", k: "previous", K: "previous", l: "child", G: "last",
    v: "selectMode", y: "copy", x: "cut", p: "paste",
  };
  return vi[e.key] ?? null;
}
