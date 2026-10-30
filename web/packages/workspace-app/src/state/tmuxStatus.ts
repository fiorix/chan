/// The status a terminal session publishes for its tmux control-mode
/// connection, shown as the control terminal's status view while connected.
/// Server-owned: the `session` frame carries the attachment's value and
/// `tmux-status` frames carry each later one; `revision` orders them.
export type TmuxStatus = { revision: number; connection?: TmuxConnectionStatus };

export type TmuxConnectionStatus = {
  /// The connected tmux's version, "major.minor".
  version: string;
  /// The session the client is attached to, once tmux announced it.
  session?: TmuxSessionStatus;
  /// Every window tmux listed, in id order.
  windows: TmuxWindowStatus[];
  /// Most windows opened as chan windows at the attach; the rest open on request.
  window_cap: number;
  /// The most recent errors, oldest first.
  errors: string[];
};

export type TmuxSessionStatus = { id: string; name: string };

export type TmuxWindowStatus = {
  /// tmux's id, "@N".
  id: string;
  name: string;
  /// Panes tmux reports in it.
  panes: number;
  /// Whether its panes have sessions: within the cap, or opened on request.
  open: boolean;
  /// The chan window minted for it, once the host answered.
  chan_window?: string;
};

/// A request of the live connection, sent as a `tmux-request` frame.
export type TmuxRequest =
  | { request: "open-window"; window: string }
  /// A new tmux window, which opens in a chan window of its own.
  | { request: "new-window" }
  /// Split tmux pane `pane` (`%N`), side by side when `horizontal`; the new
  /// pane arrives through the window's layout.
  | { request: "split"; pane: string; horizontal: boolean }
  /// Make `pane` tmux's active pane, after the page's active pane changed.
  | { request: "focus"; pane: string }
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
