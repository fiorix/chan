# @chan/marketing

Source for the public `chan.app` static site, a member of the `./web` npm-workspaces monorepo. The publishable artifact is generated into `dist/`; do not publish the source tree directly.

## Layout

```text
web/packages/marketing/
+-- package.json
+-- scripts/
|   `-- build.mjs          static generator and validator
+-- src/
|   +-- install.sh              public Unix CLI installer source
|   +-- install.ps1             public Windows CLI installer source
|   +-- pages/                  homepage, remote access guides, install, manual, and animation credits
|   +-- animation-credits.json  public attribution and original references
|   +-- AnimationGallery.svelte live workspace animation preview
|   +-- site.js
|   +-- styles.css
|   +-- site-motion.ts          shared homepage morph and site wave background
|   +-- home.css                homepage and shared landing-page layouts
|   +-- launcher-demo.ts        eager entry: mounts the launcher demo widget
|   `-- templates/
|       `-- base.html
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

The build/check gate:

- renders `/`, `/devserver/`, `/gateway/`, `/install/`, `/manual/` and its section pages, `/animations/`, `/install.sh`, and `/install.ps1`
- writes `CNAME` for `chan.app`
- copies static assets into `dist/`
- fails on missing required inputs
- fails on broken local links
- fails if generated pages infer GitHub release asset URLs instead of using runtime release metadata hooks
- fails if removed installer references reappear in generated public files
- fails if stale public copy claims reappear in generated output
- dry-runs `/dl/**` release metadata generation from a local fixture
- dry-runs collection of uploaded release assets into the metadata manifest
- builds the embedded launcher demo (see below)
- checks the animation gallery's types, interactions, and credit coverage against the workspace catalog
- serves `dist/` on loopback and smokes the public routes, including every manual section's navigation, active state, previous/next links, and section anchors

## Preview

Serve the generated artifact:

```sh
npm run build
python3 -m http.server 8080 -d dist
```

Then open `http://localhost:8080/`.

## Homepage

The homepage opens with a compact hero and the interactive Computers preview, followed by short sections for tmux control mode, Chan devserver, and Chan gateway. Local and ssh tmux examples are copyable; remote access links lead to the dedicated guides. A closing link points to the manual for terminal scripting, applications, and workspaces. All site pages share the neutral dark palette in `styles.css`; the site has no light theme or theme selector.

`site-motion.ts` mounts `HomeAtmosphere.svelte` once per site page. The homepage moves the workspace's Beaded Torus geometry into Dotted Waves as Computers enters the viewport; other pages start with the settled waves, with the horizon near the middle of the viewport. The shared canvas runner owns frame pacing, visibility, and cleanup; reduced motion shows a static wave, and unavailable WebGL falls back to canvas waves. `site-motion.js` and `site-motion.css` load through the shared template, separately from the animation gallery. `home.css` owns the landing-page layouts. Page content and links remain usable without JavaScript. Manual videos use native controls and play only when requested.

The remote access guides at `/devserver/` and `/gateway/` share `guides.css` and static, responsive block diagrams. The devserver guide covers ssh/ET connections, file transfer, desktop port forwarding, and workspace collaboration; the gateway guide covers managed environments, OAuth2, the control plane, and self-hosting, with links to the source design and deployment documentation. These pages load the shared wave background without a launcher bundle.

## Embedded Demo

The site runs the launcher SPA frontend-only, with no backend, so the homepage and manual can show a live Computers widget. The animation page also embeds the workspace's empty-pane welcome component; it does not mount the workspace app or connect to a chan server.

- `/` lazy-loads the populated Computers preview in an isolated document at `/demo/computers/`.
- `/manual/install/` eager-loads `launcher-demo.ts`, which mounts the real launcher (`@chan/launcher/demo`) as its empty first-run embed. `/manual/devserver/` embeds the devserver form in an isolated document under `/manual/demo/devserver/`. Other manual pages do not load the launcher bundle.
- The launcher widget is mounted without an `onOpenWindow` hook, so clicking a window row opens nothing.

`scripts/build.mjs` produces, under `dist/assets/`:

- `launcher-demo.{js,css}` -- the eager launcher entry.

The build serves the demo bundle from `base: "/assets/"` and scopes the launcher's global CSS to `.launcher-demo-frame` so it can never restyle the marketing page.

## Manual

`src/manual-pages.json` defines the manual's section order, titles, descriptions, and route slugs. The overview is `src/pages/manual.html`; each section's HTML lives under `src/pages/manual/`. The generator wraps each page with shared section navigation, an active-page marker, an index of its linked headings, and previous/next links. Keep section headings as self-links so the page index and shareable anchors agree. All guide content and navigation work without JavaScript. The manual covers terminal commands, editor screenshots and walkthroughs, workspace indexing and search, collaboration and client sessions, and extensions; the overview links to these chapters.

The original homepage videos are placed beside their manual topics: terminal commands, terminal write/scrollback and clipboard in Terminal; Hybrid Nav in Navigation; opening the editor in Editor; graph navigation in Graph; and empty-workspace animation in Screensavers. Videos use native controls, `preload="none"`, and still-frame JPEG posters under `assets/manual/video-posters/`. The three `assets/home/team-*.png` screenshots form an expandable team example. Older duplicate team shots and `home-hero.png`, which shows the previous launcher, are not linked.

## Animation credits and previews

`/animations/` publishes every workspace animation's attribution and original reference links as static HTML, including when JavaScript is disabled. `src/animation-credits.json` owns the public credit copy; the coverage test compares its IDs and names with the workspace catalog so a new animation cannot ship without a public credit. The original attribution comments stay beside the animation implementations.

The page alone loads `animation-gallery.{js,css}`. Its Svelte gallery mounts the real `EmptyPaneWelcome` component with no start delay, one animation at a time. Preview selection, dark/light themes, and stop/play controls surround the workspace's existing keyboard controls. `?a=<animation-id>` opens a particular preview. Reduced motion and offscreen scheduling remain owned by the shared canvas runner. The preview's theme is scoped to its stage, independent of the site's theme.

## Release verification

After a `v*` tag release completes, verify the public release assets:

```sh
npm run verify:release
```

The verifier checks the latest GitHub Release for the desktop downloads and standalone CLI tarballs. `VERSION` and `SHA256SUMS` are checked when present, but `/dl/**` metadata is the source of truth for downloads and updates.

Generate release metadata from an already verified asset manifest:

```sh
npm run collect:release -- \
  --tag vX.Y.Z \
  --out /tmp/chan-release-assets.json
npm run generate:metadata -- \
  --manifest /tmp/chan-release-assets.json \
  --out dist/dl
```

The generator writes:

- `dist/dl/releases.json`
- `dist/dl/cli/latest.json`
- `dist/dl/cli/vX.Y.Z.json`
- `dist/dl/desktop/latest.json`
- `dist/dl/desktop/vX.Y.Z.json`

The manifest must list concrete GitHub Release asset URLs and SHA256 values. It must not use GitHub `releases/latest/download` URLs. The collector builds that manifest from uploaded GitHub Release assets and detached updater signature assets.

A manual Pages deploy (`gh workflow run pages.yml`) ships marketing-only updates between releases. It rebuilds `/dl/**` from the latest GitHub Release rather than reading the live site, so the download page and update-check metadata survive the deploy. The release workflow regenerates `/dl/**` for each new tag; both paths derive the same metadata from GitHub Release assets.

While `github.com/fiorix/chan` is still private during pre-release work, use `--skip-latest-download-heads` for asset-shape checks. The public launch requires that flag to be absent so unauthenticated latest-download URLs are checked.

## Install surface

`/install/` separates two installation paths:

- Desktop: Homebrew or DMG on macOS, the Windows installer, then the Linux AppImage and managed `chan-desktop` packages.
- Server: the Unix and Windows installers first, managed `chan` packages second, then Docker and the optional self-hosted gateway.

The standalone installers support the active CLI release targets:

- Linux x86_64
- Linux aarch64
- macOS aarch64
- FreeBSD x86_64
- FreeBSD aarch64
- Windows x86_64

Desktop packages are downloaded directly as release artifacts. They are not installed by `install.sh`. Raw CLI archives remain in release metadata and on GitHub Releases, but are not presented as primary install-page choices.

Linux users can also install the root Nix flake. Its default package is `chan-desktop` on x86_64 and aarch64, with `chan` and `cs` entry points in the same output; it does not add a systemd user unit.

`install.sh` and `install.ps1` default to `https://chan.app/dl/cli/latest.json`. The Windows installer uses a separate `%LOCALAPPDATA%\chan-cli` prefix and refuses when Chan Desktop already owns the command shims. Download links on the site read `/dl/releases.json` at runtime and fall back to the GitHub Releases page if metadata is unavailable.

## Workspace boundary

This site is a member of the `./web` npm-workspaces monorepo, but unlike the embedded SPAs it is not baked into any binary: it does not participate in `cargo build`, `cargo test`, or the embedded editor bundle, and it deploys to `chan.app` via the release/pages workflows.
