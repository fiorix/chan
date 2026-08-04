# Web marketing onboarding

Status: ACCEPTED for v0.85.0, NOT specced.

Create an onboarding page for the marketing site. It may later become the site's main page.

## What's with AI?

Chan has no model API integration: agents are external and drive Chan, not the other way around. Release builds embed one local model, the default search-embedding model baked into the binary from `resources/models.tar.zst` (`crates/chan-server/src/embed_seed.rs`), which powers workspace search rather than chat.

It gives AI agents tools through the commands documented by `chan dump-skill` and through its optional MCP server. Agents can use them to create and manage terminals and other agents, collaborate on documents and presentations, and build and refine diagrams.

Agents automate their own workflows through Chan, without Chan owning or embedding the agent.

TODO: Show agents opening terminals and running other agents.

## Coming from tmux?

If you are coming from screen or tmux, especially `tmux -CC` control mode, the model maps directly.

The Chan devserver provides tmux-like persistence for the whole IDE: windows, panes, terminals, editors, and the file browser. Layouts are preserved, terminals keep running, and clients can reattach at any time.

TODO: Diagram session persistence and browser/desktop reattachment.

TODO: Diagram the devserver script and SSH tunnel setup.

## Coming from $TERMINAL

Changing terminals is a big step, so install and uninstall need to be cheap.

1. `chan` and `chan-desktop` each ship as one binary, but installation is packaged per platform: macOS DMG, Homebrew, Windows NSIS installer, COPR, PPA (`ppa:fiorix/chan`), and AUR (`chan`, `chan-desktop`); a `curl | sh` installer drops `~/.local/bin/chan` and a `cs` symlink.
2. Chan is free and open source (Apache-2.0), and can be built locally. On Arch Linux, for example: `paru -S chan-desktop`.
3. Uninstalling means deleting the binary and `~/.chan`, plus two leftovers: the embedding-model cache under the OS cache dir (`$XDG_CACHE_HOME/chan/models` on Linux, `~/Library/Caches/chan/models` on macOS, `%LOCALAPPDATA%/chan/models` on Windows), and the devserver service where one was installed (a supervised systemd user unit on Linux, launchd on macOS).

What do you get?

The home page ships a carousel of short terminal videos (`web/packages/marketing/src/pages/home.html`); the onboarding page can reuse those clips.

## Coming from $EDITOR

Target users coming from Google Docs, Microsoft Office, or Obsidian. The editor's primary audience is `vi` users; the onboarding also addresses Emacs, VS Code, and newer-editor users.

Chan's editor is a collaborative interactive tool built on top of text and code editing:

- Full-featured Markdown rendering with themes, contacts, diagrams, slide decks, and PDF export.
- Embedded Excalidraw for standalone drawing and multi-user collaboration through the Chan session.

TODO: Show the editor opening files and collaborating with agents.
