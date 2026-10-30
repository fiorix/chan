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
  | { request: "detach" }
  | { request: "end" };
