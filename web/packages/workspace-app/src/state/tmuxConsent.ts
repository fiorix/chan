/// The question a terminal session has open when a program that is not a
/// local tmux printed the tmux control-mode marker. The server asks every
/// attached client; the first answer wins, and no answer in `timeout_secs`
/// is a deny.
export type TmuxQuestion = {
  /// The foreground program's name, or "unknown".
  program: string;
  /// Its command line where the OS lets it be read.
  command?: string;
  timeout_secs: number;
};

export type TmuxConsent = { revision: number; question?: TmuxQuestion };

export type TmuxAnswer = "allow" | "allow-for-tab" | "deny";
