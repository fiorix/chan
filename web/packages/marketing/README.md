# @chan/marketing

Source for the public `chan.app` static site: the home and install pages, the user manual, the animation credits, the installers and the release metadata. A member of the `./web` npm-workspaces monorepo that no binary embeds: it takes no part in `cargo build` or `cargo test` and deploys to `chan.app` through the release and pages workflows. The publishable artifact is generated into `dist/`; do not publish the source tree directly.

## Layout

```text
web/packages/marketing/
+-- package.json
+-- scripts/
|   +-- build.mjs               static generator and validator
|   +-- smoke-dist.mjs          serves dist/ and checks the public routes
|   `-- *release*.mjs           release assets, metadata, verification
+-- fixtures/                   release-asset fixtures for the dry runs
+-- src/
|   +-- install.sh              public Unix CLI installer source
|   +-- install.ps1             public Windows CLI installer source
|   +-- pages/                  home, devserver, gateway, install, manual (and manual/*), animations
|   +-- docs.json               documentation sets: groups, page order, titles, slugs
|   +-- animation-credits.json  public attribution and original references
|   +-- AnimationGallery.svelte live empty-pane animation preview
|   +-- animation-gallery.ts    entry: mounts the gallery on /animations/
|   +-- launcher-demo.ts        entry: mounts the launcher demo
|   +-- site.js
|   +-- styles.css
|   +-- HomeAtmosphere.svelte   site background: the torus that becomes waves
|   +-- site-motion.ts          shared homepage morph and site wave background
|   +-- home.css                homepage and shared landing-page layouts
|   +-- guides.css              devserver and gateway guide layouts
|   +-- manual.css              documentation layout and page components
|   `-- templates/
|       +-- base.html           the page shell
|       `-- demo-embed.html     the isolated devserver-form demo document
+-- assets/                     public media assets copied to dist/assets/
+-- chan-favicon.png
`-- chan-mark.png
```

## Build

```sh
npm run build
```

Run the full local site gate:

```sh
npm run check
```

The build and check gate:

- renders `/`, `/devserver/`, `/gateway/`, `/install/`, `/manual/` and its section pages, `/animations/`, `/install.sh` and `/install.ps1`
- writes `CNAME` for `chan.app`
- copies static assets into `dist/`
- fails on missing required inputs, on broken local links, and on a link whose fragment names no id on the page it points at
- fails if generated pages infer GitHub release asset URLs instead of using the runtime release metadata hooks
- fails if removed installer references or stale public copy reappear in generated output
- dry-runs `/dl/**` release metadata generation from a local fixture and the collection of uploaded release assets into the metadata manifest
- builds the embedded launcher demo and the animation gallery (see below)
- checks the animation gallery's types, interactions and credit coverage against the workspace catalog
- serves `dist/` on loopback and smokes the public routes, including every documentation page's grouped navigation, active state, previous and next links, section anchors, and media sizes

## Preview

Serve the generated artifact:

```sh
npm run build
python3 -m http.server 8080 -d dist
```

## Homepage

The homepage opens with a compact hero and the interactive Computers preview, followed by short sections for tmux control mode, the devserver and the gateway. The local and ssh tmux examples are copyable; the remote access sections lead to the dedicated guides. A closing link leads to the manual. All site pages share the neutral dark palette in `styles.css`; the site has no light theme or theme selector.

`site-motion.ts` mounts `HomeAtmosphere.svelte` once per site page. The homepage moves the workspace's Beaded Torus geometry into Dotted Waves as the Computers section enters the viewport; other pages start with the settled waves. The shared canvas runner owns frame pacing, visibility and cleanup; reduced motion shows a static wave, and unavailable WebGL falls back to canvas waves. `site-motion.js` and `site-motion.css` load through the shared template, separately from the animation gallery. `home.css` owns the landing-page layouts. Page content and links remain usable without JavaScript.

The remote access guides at `/devserver/` and `/gateway/` share `guides.css` and static, responsive block diagrams. The devserver guide covers ssh and Eternal Terminal connections, file transfer, desktop port forwarding and workspace collaboration; the gateway guide covers managed environments, OAuth2, the control plane and self-hosting, with links to the source design and deployment documentation. These pages load the shared wave background without a launcher bundle.

## Embedded demo

The site runs the launcher SPA frontend-only, with no backend, so the homepage and the manual show a live Computers screen instead of a screenshot. The animations page embeds the workspace app's empty-pane welcome component; none of these pages mounts the workspace app or connects to a chan server.

- `/` lazy-loads the populated Computers preview in an isolated document at `/demo/computers/`.
- `/manual/install/` loads `launcher-demo.ts`, which mounts the real launcher (`@chan/launcher/demo`) as its empty first-run embed. `/manual/devserver/` embeds the devserver form in an isolated document under `/manual/demo/devserver/`. Other manual pages do not load the launcher bundle.
- The launcher is mounted without an `onOpenWindow` hook, so clicking a window row opens nothing.

`scripts/build.mjs` produces `launcher-demo.{js,css}` and `animation-gallery.{js,css}` under `dist/assets/`, served from `base: "/assets/"`, and scopes the launcher's global CSS to `.launcher-demo-frame` so it can never restyle the marketing page.

## Manual

`src/docs.json` defines the documentation sets. A set has a base path (`/manual/`), a sidebar label, the overview page's source, the folder holding its other pages, and groups of pages; a page has a slug, a title, a description and, where it mounts the launcher demo, `"head": "launcher-demo"`. The order of the groups and of the pages in them is the reading order: the sidebar lists the pages under their group headings, and previous and next follow it. Slugs are flat (`/manual/tmux/`), so a page can change group without changing its URL. The generator wraps each page with the sidebar, a breadcrumb naming its group, an index of its linked headings (a rail beside the page on a wide screen, a block under the title otherwise), and previous and next links. It also gives each local image, and each video with a local poster, its intrinsic width and height. Keep section headings as self-links so the page index and shareable anchors agree. All content and navigation work without JavaScript; on a narrow screen the sidebar folds into one row that opens the full list. The smoke check reads its routes from `docs.json`.

A page follows one shape, built from the components in `manual.css`: an opening figure, `ul.can-do` for what the reader can do, `ol.doc-steps` for a flow, `table.manual-table` (inside `.manual-table-wrap`) for keys, verbs and outcomes, `details.doc-details` for edge cases and limits, and `.next-cards` for where to go next. Keys are `kbd` elements, one per chord. A figure's `figcaption` sits under its media; a window grab that brings its own chrome and shadow gets no frame, and a clip, or an image with the class `framed`, gets the one the site draws. A `video` with `data-loop` plays muted while it is in view and keeps its native controls without JavaScript or with reduced motion. A `.shot-placeholder-frame` with a `data-shot` id holds the spot of a capture that is still to be made. A section that moved to a page of its own keeps its heading and id on the old page, with a short pointer to the new one. The manual covers the Linux default terminal, the devserver and its control terminal, chan in a browser without the desktop, hosting a gateway, terminal commands, the command launcher, tmux control mode, editor screenshots and walkthroughs, workspace indexing and search, collaboration and client sessions, and extensions; the overview links to these chapters by group. Step-by-step pages mark sample terminal output with `pre.sample-output`, apart from the copyable `command-copy` blocks, and set tips and warnings apart with `aside.doc-note` (add `warning` for a warning).

The product videos sit beside their manual topics: terminal commands, terminal write and scrollback, and the clipboard in Terminal; Hybrid Nav in Navigation; opening the editor in Editor; graph navigation in Graph; and the empty-workspace animation in Screensavers. Videos use native controls, `preload="none"` and still-frame JPEG posters under `assets/manual/video-posters/`, and play only when requested. The three `assets/home/team-*.png` screenshots form an expandable team example. No page links `home-hero.png`, `team-work-fleet.png` or `team-work-spawn.png` under `assets/`.

## Animation credits and previews

`/animations/` publishes every workspace animation's attribution and original reference links as static HTML, including with JavaScript disabled. `src/animation-credits.json` owns the public credit copy; the coverage test compares its ids and names with the workspace catalog so a new animation cannot ship without a public credit. The original attribution comments stay beside the animation implementations.

The page alone loads `animation-gallery.{js,css}`. Its Svelte gallery mounts the real `EmptyPaneWelcome` component with no start delay, one animation at a time, with preview selection, light and dark themes and stop and play controls around the workspace's own keyboard controls. `?a=<animation-id>` opens a particular preview; the preview's theme is scoped to its stage.

## Release verification

After a `v*` tag release completes, verify the public release assets:

```sh
npm run verify:release
```

The verifier checks the latest GitHub Release for the desktop downloads and standalone CLI tarballs. `VERSION` and `SHA256SUMS` are checked when present, but `/dl/**` metadata is the source of truth for downloads and updates. `--skip-latest-download-heads` skips the unauthenticated download checks for a release whose assets are not yet public; a public release run leaves it absent.

Generate release metadata from an already verified asset manifest:

```sh
npm run collect:release -- \
  --tag vX.Y.Z \
  --out /tmp/chan-release-assets.json
npm run generate:metadata -- \
  --manifest /tmp/chan-release-assets.json \
  --out dist/dl
```

The generator writes `dist/dl/releases.json`, `dist/dl/cli/latest.json`, `dist/dl/cli/vX.Y.Z.json`, `dist/dl/desktop/latest.json` and `dist/dl/desktop/vX.Y.Z.json`. The manifest must list concrete GitHub Release asset URLs and SHA256 values, never GitHub `releases/latest/download` URLs; the collector builds it from uploaded GitHub Release assets and detached updater signature assets.

A manual Pages deploy (`gh workflow run pages.yml`) ships marketing-only updates between releases and rebuilds `/dl/**` from the latest GitHub Release rather than the live site, so the download page and update-check metadata survive it. The release workflow regenerates `/dl/**` for each new tag; both paths derive the same metadata from GitHub Release assets.

## Install surface

`/install/` separates two installation paths:

- Desktop: Homebrew or the DMG on macOS, the Windows installer, then the Linux AppImage and the managed `chan-desktop` packages (on Arch, also the prebuilt `chan-desktop-bin`). `/manual/install/#default-terminal` explains how a Linux package becomes the default terminal through xdg-terminal-exec, and `/manual/install/#open-from-finder` how the macOS app becomes the default for Markdown files in Finder.
- Server: the Unix and Windows installers first, the managed `chan` packages second, then Docker and the optional self-hosted gateway.

The standalone installers support the active CLI release targets: Linux x86_64 and aarch64, macOS aarch64, FreeBSD x86_64 and aarch64, and Windows x86_64. Desktop packages are downloaded directly as release artifacts and are not installed by `install.sh`. Raw CLI archives remain in the release metadata and on GitHub Releases but are not presented as primary install-page choices.

Linux users can also install the root Nix flake. Its default package is `chan-desktop` on x86_64 and aarch64, with `chan` and `cs` entry points in the same output; it does not add a systemd user unit.

`install.sh` and `install.ps1` default to `https://chan.app/dl/cli/latest.json`. The Windows installer uses a separate `%LOCALAPPDATA%\chan-cli` prefix and refuses when chan-desktop already owns the command shims. Download links on the site read `/dl/releases.json` at runtime and fall back to the GitHub Releases page when the metadata is unavailable.
