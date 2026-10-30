// The tmux shapes the terminal socket and the window commands carry: a
// request of the live connection, a tmux window's layout, and the pane a
// session shows. The connection's own status is the library's, read by the
// launcher's card from the window feed; none of it reaches the page.

/// A request of the live connection, the closed set the pane-session POST
/// (`api.tmuxRequest`) and the terminal socket's `tmux-request` frame take.
/// The page sends one on a pane's session: Cmd+T, a split, a focus change,
/// the window size and the close prompt's Detach.
export type TmuxRequest =
  | { request: "open-window"; window: string }
  /// A new tmux window, which opens in a chan window of its own.
  | { request: "new-window" }
  /// Split tmux pane `pane` (`%N`), side by side when `horizontal`; the new
  /// pane arrives through the window's layout.
  | { request: "split"; pane: string; horizontal: boolean }
  /// Make `pane` tmux's active pane, after the page's active pane changed.
  | { request: "focus"; pane: string }
  /// Size the tmux window holding `pane` to the grid this window's panes can
  /// show together, dividers counted as tmux draws them; tmux lays the panes
  /// out inside it and each pane session learns its size from the layout.
  | { request: "window-size"; pane: string; cols: number; rows: number }
  | { request: "detach" }
  | { request: "end" };

/// A tmux window's layout as the connection sends it (`tmux_layout`): a pane
/// names its session once the registry made one, a row lays its children
/// side by side and a column stacks them; sizes are tmux cells.
export type TmuxLayoutNode =
  | { kind: "pane"; session: string | null; w: number; h: number }
  | { kind: "row" | "column"; children: TmuxLayoutNode[]; w: number; h: number };

/// The tmux pane a terminal session shows, as its `session` frame says.
export type TmuxPaneRef = { connection: number; pane: string };
