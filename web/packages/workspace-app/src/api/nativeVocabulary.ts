// What the installed chan-desktop grants a remotely-served page.
//
// A gateway-served window is delivered by the remote devserver while the ACL
// gating its invokes belongs to the chan-desktop installed on this machine,
// so the page and the app are independently versioned and the page can name
// a command the app has never heard of. Two mechanisms cover that split:
//
// - `hostVocabulary` asks the app what it grants, so a missing command can be
//   reported as a version statement before any invoke is attempted. An app
//   old enough to lack an advertised command is also old enough to lack the
//   query itself, so a failed query does not mean "nothing granted", it means
//   "this app cannot say"; the caller falls back to the second mechanism.
// - `isAclRefusal` classifies a thrown rejection after the fact. For every
//   build predating the advertisement it is the only mechanism there will
//   ever be.

import { isTauriDesktop, readNativeVocabulary } from "./desktop";

/// Whether a rejected invoke was the app's ACL withholding the command rather
/// than a command that ran and failed.
///
/// Tauri rejects an ungranted command before any handler runs, so the text is
/// Tauri's: a release build reports `Command {cmd} not allowed by ACL` and a
/// debug build one of several longer diagnostics. Every form names the command
/// and says it is not allowed or explicitly denied, while the native
/// library-window handlers report their own failures in other words entirely
/// (a missing library, a disconnected devserver, an unknown window). Requiring
/// both conditions is what keeps a handler's real reason from being reported
/// as a version problem.
export function isAclRefusal(command: string, message: string): boolean {
  if (!message.includes(command)) return false;
  return message.includes("not allowed") || message.includes("explicitly denied");
}

let cached: ReadonlySet<string> | null = null;

/// The command vocabulary the installed app advertises, or null when it
/// cannot say (not a Tauri webview, or an app that predates the query).
///
/// Success is cached for the page's life: the vocabulary is a build property.
/// Failure is NOT cached, because the minted origin grant can land after this
/// window opens (the mint reaches already-open windows on their next invoke),
/// so a query refused now may resolve later.
export async function hostVocabulary(): Promise<ReadonlySet<string> | null> {
  if (!isTauriDesktop()) return null;
  if (cached) return cached;
  try {
    const advertised = await readNativeVocabulary();
    if (!Array.isArray(advertised?.commands)) return null;
    cached = new Set(advertised.commands);
    return cached;
  } catch {
    return null;
  }
}

export function resetHostVocabularyForTests(): void {
  cached = null;
}
