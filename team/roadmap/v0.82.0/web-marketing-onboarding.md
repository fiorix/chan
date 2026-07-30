# Web marketing onboarding

Status: REGISTERED for v0.82.0, NOT specced.

Create an onboarding page for the marketing site. It may later become the site's main page.

## What's with AI?

Chan has no embedded AI or model API integration.

It gives AI agents tools through the commands documented by `chan dump-skill` and through its optional MCP server. Agents can use them to create and manage terminals and other agents, collaborate on documents and presentations, and build and refine diagrams.

The message is that agents can automate their own workflows through Chan, without Chan owning or embedding the agent.

TODO: Show agents opening terminals and running other agents.

## Coming from tmux?

We love tmux, and screen too.

If you are coming from screen or tmux—especially `tmux -CC`—the model should feel familiar.

The Chan devserver provides tmux-like persistence for the whole IDE: windows, panes, terminals, editors, and the file browser. Layouts are preserved, terminals keep running, and clients can reattach at any time.

TODO: Diagram session persistence and browser/desktop reattachment.

TODO: Diagram the devserver script and SSH tunnel setup.

## Coming from $TERMINAL

Hello.

Changing terminals is a big step. All we ask is that people try it.

1. Both `chan` and `chan-desktop` are single binaries: installation is essentially downloading and running one file.
2. Chan is free and open source, and can be built locally. On Arch Linux, for example: `paru -S chan-desktop`.
3. Uninstalling takes two steps: delete the binary and delete `~/.chan`.

What do you get?

TODO: Carousel of short terminal videos.

## Coming from $EDITOR

Coming from Google Docs, Microsoft Office, or Obsidian? Same here.

We are longtime writers and primarily `vi` users. We also welcome Emacs, VS Code, and newer-editor users.

Chan's editor is a collaborative interactive tool built on top of text and code editing:

- Full-featured Markdown rendering with themes, contacts, diagrams, slide decks, and PDF export.
- Embedded Excalidraw for standalone drawing and multi-user collaboration through the Chan session.

TODO: Show the editor opening files and collaborating with agents.
