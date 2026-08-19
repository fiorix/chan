//! `chan dump-skill`: an agent-facing skill document rendered from chan's
//! own help text.
//!
//! The load-bearing rule: EVERY byte this emits is reachable from some
//! `--help`. Command sections are rendered live off the clap trees
//! ([`Cli`] and [`chan_shell::CsCli`]) through `render_long_help`, so a
//! section cannot drift from the command it documents. Concept prose (the
//! graph model, team rounds, devserver setup) does not get a private
//! corpus here: it lives in the `after_long_help` const of the command
//! that owns the knowledge, which is why improving the skill and improving
//! `chan X --help` are the same edit. This module stores only the spine,
//! the frontmatter, and the closing index.
//!
//! Two clap facts constrain every help string this renders, and both are
//! silent failures rather than build errors:
//!
//!   - The workspace pins `clap` WITHOUT `wrap_help`, so `long_about` and
//!     `after_long_help` reach the terminal verbatim. Help text is
//!     hand-wrapped at 76 columns; nothing rewraps it.
//!   - A derive doc comment collapses its paragraphs into one line. Any
//!     help with structure (examples, tables, unit files) therefore lives
//!     in a `const` wired up as `long_about` / `after_long_help`; doc
//!     comments stay a single short prose paragraph.

use anyhow::{bail, Result};
use clap::{Command as ClapCommand, CommandFactory};

use crate::Cli;

/// Which clap tree a section renders from. The `cs` surface is its own
/// parser rather than a subtree of `chan`, so the two roots stay separate
/// here exactly as they are on the command line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Root {
    Chan,
    Cs,
}

impl Root {
    fn command(self) -> ClapCommand {
        // `build` propagates bin names down the tree, so a nested
        // subcommand renders `Usage: cs terminal team` instead of a bare
        // `Usage: team`. Same reason the cs help test calls it.
        let mut cmd = match self {
            Root::Chan => Cli::command(),
            Root::Cs => chan_shell::CsCli::command(),
        };
        cmd.build();
        cmd
    }

    fn prefix(self) -> &'static str {
        match self {
            Root::Chan => "chan",
            Root::Cs => "cs",
        }
    }
}

/// One `##` section of the skill: a command whose help IS the section.
struct Section {
    /// Primary `--topic` key.
    slug: &'static str,
    /// Extra `--topic` keys. Concept topics fold into the command that
    /// owns them, so `--topic graph` and `--topic teams` resolve to the
    /// commands whose help carries that knowledge.
    aliases: &'static [&'static str],
    /// Short label for `--list`.
    title: &'static str,
    root: Root,
    /// Subcommand path under the root. Empty means the root itself.
    path: &'static [&'static str],
}

/// Emission order: orientation, then the workspace lifecycle, then the
/// `cs` surface an agent actually drives, then the workspace-content and
/// devserver commands. Teaching order, not alphabetical.
static SPINE: &[Section] = &[
    Section {
        slug: "overview",
        aliases: &["chan", "orientation"],
        title: "What chan is, and the two ways to run it",
        root: Root::Chan,
        path: &[],
    },
    Section {
        slug: "serve",
        aliases: &["open", "workspace", "launcher", "apps", "keybindings"],
        title: "Serve a workspace; the command launcher and the apps",
        root: Root::Chan,
        path: &["serve"],
    },
    Section {
        slug: "close",
        aliases: &["terminals", "library"],
        title: "Close a workspace; managing the chan library",
        root: Root::Chan,
        path: &["close"],
    },
    Section {
        slug: "forget",
        aliases: &["rm", "remove"],
        title: "Forget a workspace from the registry",
        root: Root::Chan,
        path: &["workspace", "forget"],
    },
    Section {
        slug: "ps",
        aliases: &[],
        title: "See which workspaces are being served",
        root: Root::Chan,
        path: &["ps"],
    },
    Section {
        slug: "cs",
        aliases: &["env", "mcp", "detect"],
        title: "The cs surface: the environment contract and MCP",
        root: Root::Cs,
        path: &[],
    },
    Section {
        slug: "cs-open",
        aliases: &["edit"],
        title: "Open a file, directory, or graph link in the window",
        root: Root::Cs,
        path: &["open"],
    },
    Section {
        slug: "cs-graph",
        aliases: &["graph"],
        title: "The project graph: model, navigation, and links",
        root: Root::Cs,
        path: &["graph"],
    },
    Section {
        slug: "cs-search",
        aliases: &["search", "traversal", "selectors"],
        title: "Search and traverse the workspace graph",
        root: Root::Cs,
        path: &["search"],
    },
    Section {
        slug: "cs-export",
        aliases: &["authoring", "pdf", "slides", "diagrams", "pagebreak"],
        title: "Authoring: diagrams, slides, page breaks, PDF export",
        root: Root::Cs,
        path: &["export"],
    },
    Section {
        slug: "cs-copy",
        aliases: &["clipboard"],
        title: "Copy onto the window's clipboard",
        root: Root::Cs,
        path: &["copy"],
    },
    Section {
        slug: "cs-tunnel",
        aliases: &["tunnel", "port-forward"],
        title: "Forward a desktop port back to a devserver port",
        root: Root::Cs,
        path: &["tunnel"],
    },
    Section {
        slug: "cs-paste",
        aliases: &[],
        title: "Paste the window's clipboard to stdout",
        root: Root::Cs,
        path: &["paste"],
    },
    Section {
        slug: "cs-upload",
        aliases: &["transfer"],
        title: "Upload files into the window",
        root: Root::Cs,
        path: &["upload"],
    },
    Section {
        slug: "cs-download",
        aliases: &[],
        title: "Download a file or directory through the window",
        root: Root::Cs,
        path: &["download"],
    },
    Section {
        slug: "cs-terminal",
        aliases: &["tabs"],
        title: "Drive terminal tabs from a terminal",
        root: Root::Cs,
        path: &["terminal"],
    },
    Section {
        slug: "cs-terminal-new",
        aliases: &[],
        title: "Open a new terminal tab",
        root: Root::Cs,
        path: &["terminal", "new"],
    },
    Section {
        slug: "cs-terminal-write",
        aliases: &["poke", "submit"],
        title: "Write to a live terminal, and poke an agent",
        root: Root::Cs,
        path: &["terminal", "write"],
    },
    Section {
        slug: "cs-terminal-list",
        aliases: &[],
        title: "List live terminal sessions",
        root: Root::Cs,
        path: &["terminal", "list"],
    },
    Section {
        slug: "cs-terminal-scrollback",
        aliases: &[],
        title: "Read another terminal's scrollback",
        root: Root::Cs,
        path: &["terminal", "scrollback"],
    },
    Section {
        slug: "cs-terminal-restart",
        aliases: &[],
        title: "Restart a live terminal session",
        root: Root::Cs,
        path: &["terminal", "restart"],
    },
    Section {
        slug: "cs-terminal-close",
        aliases: &[],
        title: "Tear down a live terminal session",
        root: Root::Cs,
        path: &["terminal", "close"],
    },
    Section {
        slug: "cs-terminal-survey",
        aliases: &["ask", "followup"],
        title: "Ask the host a question and block on the answer",
        root: Root::Cs,
        path: &["terminal", "survey"],
    },
    Section {
        slug: "cs-terminal-team",
        aliases: &["teams", "team", "workflows", "rounds"],
        title: "Spawn and run a team of agents",
        root: Root::Cs,
        path: &["terminal", "team"],
    },
    Section {
        slug: "cs-pane",
        aliases: &["panes", "splits"],
        title: "Inspect and rearrange panes and tabs",
        root: Root::Cs,
        path: &["pane"],
    },
    Section {
        slug: "cs-window",
        aliases: &["windows"],
        title: "List and manage windows",
        root: Root::Cs,
        path: &["window"],
    },
    Section {
        slug: "cs-session",
        aliases: &[],
        title: "Inspect this terminal's session, and hand it over",
        root: Root::Cs,
        path: &["session"],
    },
    Section {
        slug: "cs-dashboard",
        aliases: &[],
        title: "Open a Dashboard tab",
        root: Root::Cs,
        path: &["dashboard"],
    },
    Section {
        slug: "contacts",
        aliases: &["import"],
        title: "Import contacts, and how they land in the graph",
        root: Root::Chan,
        path: &["workspace", "contacts", "import", "csv"],
    },
    Section {
        slug: "devserver",
        aliases: &["remote", "lima", "wsl", "systemd"],
        title: "Run a devserver: Linux, macOS, Windows",
        root: Root::Chan,
        path: &["devserver"],
    },
    Section {
        slug: "register",
        aliases: &["devserver-register"],
        title: "Register a remote devserver with the desktop",
        root: Root::Chan,
        path: &["devserver", "register"],
    },
    Section {
        slug: "config",
        aliases: &["settings"],
        title: "Read and write settings outside the workspace",
        root: Root::Chan,
        path: &["config"],
    },
];

/// Visible commands the spine deliberately does not carry a section for.
/// Exact paths, checked by `every_visible_command_is_covered`. Coverage is
/// never inherited from a parent, so every entry here is somebody deciding
/// this command does not need its own page. The list may shrink; growing
/// it means a command shipped undocumented, which is what the test exists
/// to catch.
#[cfg(test)]
static UNDOCUMENTED: &[(Root, &[&str])] = &[
    // `chan shell ...` is the `cs` tree under its long spelling. The `cs`
    // root carries it; a second copy would duplicate every section. The
    // whole subtree goes with it.
    (Root::Chan, &["shell"]),
    // Setup and self-maintenance, not workspace work.
    (Root::Chan, &["completions"]),
    (Root::Chan, &["upgrade"]),
    // The command that prints this document. The lead and the closing
    // index already teach `--list` / `--topic`.
    (Root::Chan, &["dump-skill"]),
    // Registry and index maintenance. An agent reaches workspace content
    // through `cs search`, and the registry through `chan serve` / `close`.
    (Root::Chan, &["workspace"]),
    (Root::Chan, &["workspace", "add"]),
    (Root::Chan, &["workspace", "ls"]),
    // The family spellings of the elevated serve/close pair; the `serve`
    // and `close` sections carry the same help verbatim.
    (Root::Chan, &["workspace", "serve"]),
    (Root::Chan, &["workspace", "close"]),
    (Root::Chan, &["workspace", "index"]),
    (Root::Chan, &["workspace", "index", "rebuild"]),
    (Root::Chan, &["workspace", "index", "download-model"]),
    (Root::Chan, &["workspace", "index", "list-models"]),
    (Root::Chan, &["workspace", "index", "set-model"]),
    (Root::Chan, &["workspace", "index", "enable-semantic"]),
    (Root::Chan, &["workspace", "index", "disable-semantic"]),
    (Root::Chan, &["workspace", "index", "status"]),
    (Root::Chan, &["workspace", "reports"]),
    (Root::Chan, &["workspace", "reports", "enable"]),
    (Root::Chan, &["workspace", "reports", "disable"]),
    (Root::Chan, &["workspace", "metadata", "export"]),
    (Root::Chan, &["workspace", "metadata", "import"]),
    (Root::Chan, &["workspace", "metadata", "inspect"]),
    (Root::Chan, &["workspace", "search"]),
    (Root::Chan, &["workspace", "graph"]),
    (Root::Chan, &["workspace", "status"]),
    (Root::Chan, &["workspace", "metadata"]),
    (Root::Chan, &["workspace", "contacts"]),
    (Root::Chan, &["workspace", "contacts", "import"]),
    // Leaves whose group page enumerates them with worked examples.
    (Root::Chan, &["devserver", "run"]),
    (Root::Chan, &["devserver", "start"]),
    (Root::Chan, &["devserver", "stop"]),
    (Root::Chan, &["devserver", "restart"]),
    (Root::Chan, &["devserver", "status"]),
    (Root::Chan, &["devserver", "join"]),
    (Root::Chan, &["devserver", "rotate-token"]),
    (Root::Chan, &["devserver", "ls"]),
    (Root::Chan, &["devserver", "connect"]),
    (Root::Chan, &["devserver", "disconnect"]),
    (Root::Chan, &["devserver", "forget"]),
    (Root::Chan, &["config", "get"]),
    (Root::Chan, &["config", "set"]),
    (Root::Cs, &["terminal", "team", "new"]),
    (Root::Cs, &["terminal", "team", "load"]),
    (Root::Cs, &["window", "list"]),
    (Root::Cs, &["window", "new"]),
    (Root::Cs, &["window", "open"]),
    (Root::Cs, &["window", "rm"]),
    (Root::Cs, &["window", "hide"]),
    (Root::Cs, &["session", "list"]),
    (Root::Cs, &["session", "self"]),
    (Root::Cs, &["session", "handover"]),
    (Root::Cs, &["session", "takeover"]),
    (Root::Cs, &["pane", "list"]),
    (Root::Cs, &["pane", "new"]),
    (Root::Cs, &["pane", "focus"]),
    (Root::Cs, &["pane", "split"]),
    (Root::Cs, &["pane", "resize"]),
    (Root::Cs, &["pane", "equalize"]),
    (Root::Cs, &["pane", "swap"]),
    (Root::Cs, &["pane", "close"]),
    (Root::Cs, &["pane", "close-tab"]),
    (Root::Cs, &["pane", "close-pane"]),
    (Root::Cs, &["pane", "close-all"]),
];

/// Walk the visible commands of a tree, yielding each one's path and node.
/// Skips clap's generated `help` subcommand, which mirrors the entire tree
/// and would otherwise double every check against it.
#[cfg(test)]
fn walk_visible(root: Root, mut visit: impl FnMut(&[String], &ClapCommand)) {
    fn recurse(
        cmd: &ClapCommand,
        path: &mut Vec<String>,
        visit: &mut impl FnMut(&[String], &ClapCommand),
    ) {
        for sub in cmd.get_subcommands() {
            if sub.is_hide_set() || sub.get_name() == "help" {
                continue;
            }
            path.push(sub.get_name().to_string());
            visit(path, sub);
            recurse(sub, path, visit);
            path.pop();
        }
    }
    let cmd = root.command();
    visit(&[], &cmd);
    recurse(&cmd, &mut Vec::new(), &mut visit);
}

/// Feed every long-form help string in both trees to `check`, tagged with
/// the invocation that renders it. Skips the `chan shell` subtree: those
/// are the same strings as the `cs` tree, and reporting each finding twice
/// makes a failure harder to read, not easier.
#[cfg(test)]
fn for_each_help(mut check: impl FnMut(&str, &str)) {
    for root in [Root::Chan, Root::Cs] {
        walk_visible(root, |path, cmd| {
            if root == Root::Chan && path.first().map(String::as_str) == Some("shell") {
                return;
            }
            let mut name = String::from(root.prefix());
            for part in path {
                name.push(' ');
                name.push_str(part);
            }
            for text in [
                cmd.get_about(),
                cmd.get_long_about(),
                cmd.get_after_long_help(),
            ]
            .into_iter()
            .flatten()
            {
                check(&name, &text.to_string());
            }
        });
    }
}

/// Frontmatter for the emitted skill. Matches the three-key shape every
/// file under `.agents/skills/` uses, because that is the shape agent
/// harnesses parse.
const SKILL_FRONTMATTER: &str = "\
---
name: chan
description: >-
  Drive chan from its terminal: the `cs` command surface, the command
  launcher and built-in apps, document authoring with diagrams and slide
  decks, the project graph, teams of agents, and devservers.
when_to_use: >-
  You are running inside a chan terminal (`$CHAN` is set), or the user
  asks how to do something in chan.
---
";

/// The only prose in this file. Everything after it is command help.
const SKILL_LEAD: &str = "\
# Working in chan

Each section below is the live `--help` of a real command, so it is never
stale. Run `chan dump-skill --list` for the topic index and `chan
dump-skill --topic <slug>` for one section.

Start with `overview` for what chan is, `cs` for the environment contract
and how to tell where you are running, and `open` for the workspace and
its apps.
";

/// Resolve a section's clap node and render its long help as plain text.
/// `StyledStr` renders without ANSI through `Display`, so the output is
/// safe to embed in markdown.
fn render_command(section: &Section) -> Result<String> {
    let mut cmd = section.root.command();
    for (depth, name) in section.path.iter().enumerate() {
        cmd = match cmd.find_subcommand(name) {
            Some(found) => found.clone(),
            None => bail!(
                "skill spine names `{} {}`, which is not a command",
                section.root.prefix(),
                section.path[..=depth].join(" ")
            ),
        };
    }
    Ok(cmd.render_long_help().to_string())
}

/// The heading an agent sees, and the invocation it can copy: `cs terminal
/// team`, `chan serve`, or a bare root.
fn section_heading(section: &Section) -> String {
    let mut parts = vec![section.root.prefix().to_string()];
    parts.extend(section.path.iter().map(|part| part.to_string()));
    parts.join(" ")
}

fn render_section(section: &Section) -> Result<String> {
    let help = render_command(section)?;
    Ok(format!(
        "## {}\n\n{}\n\n```text\n{}```\n",
        section_heading(section),
        section.title,
        // clap's long help already ends in a newline; a fence needs the
        // line to be terminated, not doubled.
        if help.ends_with('\n') {
            help
        } else {
            format!("{help}\n")
        }
    ))
}

fn find_section(topic: &str) -> Option<&'static Section> {
    SPINE
        .iter()
        .find(|section| section.slug == topic || section.aliases.contains(&topic))
}

/// `chan dump-skill --list`: every topic, one per line, plus the aliases
/// so an agent can guess a noun and still land somewhere.
pub(crate) fn render_list() -> String {
    let width = SPINE
        .iter()
        .map(|section| section.slug.len())
        .max()
        .unwrap_or(0);
    let mut out = String::new();
    for section in SPINE {
        out.push_str(&format!(
            "{:width$}  {}\n",
            section.slug,
            section.title,
            width = width
        ));
        if !section.aliases.is_empty() {
            out.push_str(&format!(
                "{:width$}  also: {}\n",
                "",
                section.aliases.join(", "),
                width = width
            ));
        }
    }
    out
}

/// `chan dump-skill --topic <slug>`: one section's help, raw. No
/// frontmatter, because a fragment is not a skill file.
pub(crate) fn render_topic(topic: &str) -> Result<String> {
    match find_section(topic) {
        Some(section) => render_command(section),
        None => {
            let slugs: Vec<&str> = SPINE.iter().map(|section| section.slug).collect();
            bail!(
                "unknown topic `{topic}`; known topics: {}",
                slugs.join(", ")
            )
        }
    }
}

/// The whole skill: frontmatter, lead, every section in spine order, and a
/// closing index that points back at `--topic`.
pub(crate) fn render_skill() -> Result<String> {
    let mut out = String::new();
    out.push_str(SKILL_FRONTMATTER);
    out.push('\n');
    out.push_str(SKILL_LEAD);
    out.push('\n');
    for section in SPINE {
        out.push_str(&render_section(section)?);
        out.push('\n');
    }
    out.push_str("## Manual index\n\n");
    out.push_str("Run `chan dump-skill --topic <slug>` for any of these.\n\n");
    for section in SPINE {
        out.push_str(&format!(
            "- `{}` -- {} (`{}`)\n",
            section.slug,
            section.title,
            section_heading(section)
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dumped_terminal_help_names_kimi_and_agy_as_submit_agents() {
        let list = render_topic("cs-terminal-list").expect("terminal list help");
        let team = render_topic("cs-terminal-team").expect("terminal team help");
        let write = render_topic("cs-terminal-write").expect("terminal write help");
        for (name, help) in [("list", list), ("team", team), ("write", write)] {
            assert!(help.contains("kimi"), "{name} help omits kimi");
            assert!(help.contains("agy"), "{name} help omits agy");
        }
    }

    /// Column budget for hand-wrapped help text. Leaves room inside an
    /// 80-column terminal for the two-space indent clap puts in front of
    /// nested help.
    const MAX_HELP_WIDTH: usize = 76;

    /// Every path in the spine resolves. Catches a renamed or removed
    /// subcommand at test time instead of at an agent's first read.
    #[test]
    fn spine_paths_resolve() {
        for section in SPINE {
            render_command(section)
                .unwrap_or_else(|err| panic!("spine slug `{}`: {err}", section.slug));
        }
    }

    #[test]
    fn slugs_and_aliases_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for section in SPINE {
            assert!(
                seen.insert(section.slug),
                "duplicate topic key `{}`",
                section.slug
            );
            for alias in section.aliases {
                assert!(seen.insert(alias), "duplicate topic key `{alias}`");
            }
        }
    }

    /// Walk both clap trees and require every visible command to be either
    /// a spine section or an explicit exemption. Coverage is by EXACT path:
    /// letting a parent cover its descendants would wave the whole `chan
    /// workspace` subtree through and make this test decorative.
    #[test]
    fn every_visible_command_is_covered() {
        let mut missing = Vec::new();
        for root in [Root::Chan, Root::Cs] {
            walk_visible(root, |path, _cmd| {
                if path.is_empty() {
                    return;
                }
                let owned: Vec<&str> = path.iter().map(String::as_str).collect();
                let covered = SPINE
                    .iter()
                    .any(|section| section.root == root && section.path == owned.as_slice())
                    || UNDOCUMENTED
                        .iter()
                        .any(|(exempt, exempt_path)| *exempt == root && *exempt_path == owned);
                // Only `chan shell` exempts a subtree, because it IS the
                // `cs` tree. Everywhere else coverage is per command, so a
                // new leaf cannot hide behind a documented parent.
                let under_alias = root == Root::Chan && owned.first() == Some(&"shell");
                if !covered && !under_alias {
                    missing.push(format!("{} {}", root.prefix(), owned.join(" ")));
                }
            });
        }
        assert!(
            missing.is_empty(),
            "these visible commands have no skill section and are not in UNDOCUMENTED:\n  {}",
            missing.join("\n  ")
        );
    }

    /// clap emits help verbatim (the workspace pins clap without
    /// `wrap_help`), so an over-long line is an over-long line in the
    /// user's terminal. ASCII-only and no em dash come from
    /// `.agents/writing-rules.md`.
    #[test]
    fn help_text_is_hand_wrapped() {
        let mut problems = Vec::new();
        for_each_help(|name, text| {
            for (index, line) in text.lines().enumerate() {
                let line_no = index + 1;
                let columns = line.chars().count();
                if columns > MAX_HELP_WIDTH {
                    problems.push(format!(
                        "{name}:{line_no}: {columns} columns (max {MAX_HELP_WIDTH})"
                    ));
                }
                if !line.is_ascii() {
                    problems.push(format!("{name}:{line_no}: non-ASCII"));
                }
                if line.contains('\t') {
                    problems.push(format!("{name}:{line_no}: tab"));
                }
                if line.contains("```") {
                    problems.push(format!("{name}:{line_no}: breaks the skill code fence"));
                }
            }
        });
        assert!(
            problems.is_empty(),
            "help text must be hand-wrapped ASCII (clap does not rewrap it):\n  {}",
            problems.join("\n  ")
        );
    }

    /// A command's `about` is one row of its parent's command list, so it
    /// has to be a single short line. clap derives it from the doc
    /// comment's first PARAGRAPH, not its first line, which is why a
    /// wrapped three-line doc comment silently becomes a 250-column row.
    #[test]
    fn command_summaries_are_one_short_line() {
        let mut problems = Vec::new();
        for root in [Root::Chan, Root::Cs] {
            walk_visible(root, |path, cmd| {
                if root == Root::Chan && path.first().map(String::as_str) == Some("shell") {
                    return;
                }
                let Some(about) = cmd.get_about() else { return };
                let about = about.to_string();
                let name = format!("{} {}", root.prefix(), path.join(" "));
                if about.lines().count() > 1 {
                    problems.push(format!(
                        "{name}: summary spans {} lines; move the detail to a \
                         long_about const",
                        about.lines().count()
                    ));
                } else if about.chars().count() > MAX_HELP_WIDTH {
                    problems.push(format!(
                        "{name}: summary is {} columns (max {MAX_HELP_WIDTH})",
                        about.chars().count()
                    ));
                }
            });
        }
        assert!(
            problems.is_empty(),
            "each command summary is one row of its parent's command list:\n  {}",
            problems.join("\n  ")
        );
    }

    /// Every `chan ...` / `cs ...` invocation an EXAMPLES block shows must
    /// be a real command. This is the mechanical form of the standing rule
    /// that help text never claims behavior chan does not have.
    #[test]
    fn help_examples_name_real_commands() {
        fn resolve(root: Root, words: &[&str]) -> bool {
            let mut cmd = root.command();
            for word in words {
                // Both trees set `infer_subcommands`, so `cs t l` is a real
                // invocation and the help says so. Accept an unambiguous
                // prefix exactly as the parser would, or this test rejects
                // the abbreviations it is meant to protect.
                let next = cmd.find_subcommand(word).cloned().or_else(|| {
                    let mut matches = cmd
                        .get_subcommands()
                        .filter(|sub| sub.get_name().starts_with(word));
                    let first = matches.next()?;
                    matches.next().is_none().then(|| first.clone())
                });
                match next {
                    Some(found) => cmd = found,
                    None => return false,
                }
            }
            true
        }

        // Two places a command legitimately appears: an indented line
        // inside EXAMPLES, or a backtick-quoted span anywhere. Prose is
        // skipped on purpose, and the EXAMPLES scoping matters as much as
        // the indent: other sections indent their body too, so a wrapped
        // sentence whose continuation line begins "chan desktop app" is
        // not an invocation. A check that cries wolf gets ignored.
        fn candidates(line: &str, in_examples: bool) -> Vec<String> {
            let mut out = Vec::new();
            if in_examples && line.starts_with(' ') && !line.trim_start().is_empty() {
                out.push(line.trim_start().to_string());
            }
            let mut rest = line;
            while let Some(open) = rest.find('`') {
                let after = &rest[open + 1..];
                let Some(close) = after.find('`') else { break };
                out.push(after[..close].trim().to_string());
                rest = &after[close + 1..];
            }
            out
        }

        let mut bad = Vec::new();
        for_each_help(|name, text| {
            let mut in_examples = false;
            for line in text.lines() {
                // Section headings are the template's uppercase labels.
                if line
                    .strip_suffix(':')
                    .is_some_and(|head| !head.is_empty() && head == head.to_uppercase())
                    && !line.starts_with(' ')
                {
                    in_examples = line.starts_with("EXAMPLES");
                }
                for candidate in candidates(line, in_examples) {
                    for (prefix, tree) in [("chan ", Root::Chan), ("cs ", Root::Cs)] {
                        let Some(rest) = candidate.strip_prefix(prefix) else {
                            continue;
                        };
                        // The subcommand path is the leading run of bare
                        // lowercase words; it ends at the first flag,
                        // placeholder, path, or shell metacharacter.
                        let words: Vec<&str> = rest
                            .split_whitespace()
                            .take_while(|word| {
                                !word.is_empty()
                                    && word.chars().all(|c| c.is_ascii_lowercase() || c == '-')
                                    && !word.starts_with('-')
                            })
                            .collect();
                        if words.is_empty() || resolve(tree, &words) {
                            continue;
                        }
                        // Trim from the right: `cs open notes` ends in an
                        // argument, not a subcommand.
                        if (1..words.len()).any(|len| resolve(tree, &words[..len])) {
                            continue;
                        }
                        bad.push(format!("{name}: `{prefix}{}`", words.join(" ")));
                    }
                }
            }
        });
        assert!(
            bad.is_empty(),
            "help text names commands that do not exist:\n  {}",
            bad.join("\n  ")
        );
    }

    /// Every `--topic X` the help points at must be a real topic, so a
    /// cross-reference never dead-ends.
    #[test]
    fn help_cross_references_resolve() {
        let mut bad = Vec::new();
        for_each_help(|name, text| {
            // Collapse the hand-wrapping first: a reference broken across a
            // line ends up as `--topic\ncs`, which no scan for `--topic `
            // followed by a slug would ever see.
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            for (index, _) in text.match_indices("--topic ") {
                let rest = &text[index + "--topic ".len()..];
                let topic: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                    .collect();
                // `--topic <SLUG>` in a usage line is a placeholder, not a
                // reference: the slug scan stops on the angle bracket and
                // collects nothing.
                if topic.is_empty() {
                    continue;
                }
                if find_section(&topic).is_none() {
                    bad.push(format!("{name}: `--topic {topic}`"));
                }
            }
        });
        assert!(
            bad.is_empty(),
            "help text points at topics that do not exist:\n  {}",
            bad.join("\n  ")
        );
    }

    /// A page pointing at its own topic tells the reader to go where they
    /// already are. Cross-references have to cross.
    #[test]
    fn help_cross_references_are_not_self_links() {
        let mut bad = Vec::new();
        for section in SPINE {
            let heading = section_heading(section);
            let mut cmd = section.root.command();
            for name in section.path {
                cmd = cmd.find_subcommand(name).expect("spine path").clone();
            }
            for text in [cmd.get_long_about(), cmd.get_after_long_help()] {
                let Some(text) = text else { continue };
                let text = text.to_string();
                for (index, _) in text.match_indices("--topic ") {
                    let topic: String = text[index + "--topic ".len()..]
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                        .collect();
                    if topic == section.slug || section.aliases.contains(&topic.as_str()) {
                        bad.push(format!("{heading} points at its own `--topic {topic}`"));
                    }
                }
            }
        }
        assert!(
            bad.is_empty(),
            "self-referential links:\n  {}",
            bad.join("\n  ")
        );
    }

    #[test]
    fn skill_renders_with_frontmatter_and_every_section() {
        let skill = render_skill().expect("skill renders");
        assert!(skill.starts_with("---\nname: chan\n"), "frontmatter first");
        for section in SPINE {
            let heading = format!("## {}", section_heading(section));
            assert!(skill.contains(&heading), "missing section {heading}");
        }
        // The keybindings block in `chan serve` carries generator markers
        // for the contributor who resyncs it. They are noise to an agent.
        assert!(
            !skill.contains("BEGIN GENERATED"),
            "generator markers leaked into the skill"
        );
    }

    #[test]
    fn topic_lookup_accepts_aliases_and_rejects_junk() {
        assert!(render_topic("teams").is_ok(), "alias resolves");
        assert!(render_topic("cs-terminal-team").is_ok(), "slug resolves");
        let err = render_topic("nope").expect_err("unknown topic errors");
        assert!(
            err.to_string().contains("known topics"),
            "error should list the topics: {err}"
        );
    }

    /// Agents write files, so the authoring section must teach the
    /// materialized forms the renderers actually recognize: the
    /// page-break hr line and a concrete formatted date. The @-macros
    /// (@pagebreak, @break, @today, @date) expand only while typing in
    /// the live editor; a help edit that drops the materialized forms
    /// would send agents back to writing inert markers.
    #[test]
    fn authoring_topic_teaches_materialized_forms() {
        let text = render_topic("cs-export").expect("cs-export renders");
        assert!(
            text.contains("<hr class=\"chan-page-break\">"),
            "cs-export help must show the materialized page-break form"
        );
        assert!(
            text.contains("2026-07-23"),
            "cs-export help must show a concrete ISO date example"
        );
    }

    #[test]
    fn list_names_every_topic() {
        let list = render_list();
        for section in SPINE {
            assert!(list.contains(section.slug), "missing {}", section.slug);
        }
    }
}
