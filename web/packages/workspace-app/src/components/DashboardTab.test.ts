import { describe, expect, test } from "vitest";
import tabs from "../state/tabs.svelte.ts?raw";
import pane from "./Pane.svelte?raw";
import carousel from "./EmptyPaneCarousel.svelte?raw";
import dashboard from "./DashboardTab.svelte?raw";
import app from "../App.svelte?raw";
import shell from "./HybridSurfaceConfigShell.svelte?raw";
import dashboardBack from "./dashboard/DashboardSlotBack.svelte?raw";
import workspaceSlot from "./dashboard/WorkspaceSlotConfig.svelte?raw";
import indexControl from "./settings/workspace/IndexControl.svelte?raw";
import semanticControl from "./settings/workspace/SemanticControl.svelte?raw";
import excludedDirsControl from "./settings/workspace/ExcludedDirsControl.svelte?raw";
import reportsControl from "./settings/workspace/ReportsControl.svelte?raw";
import metadataControl from "./settings/workspace/MetadataControl.svelte?raw";
import screenLockControl from "./settings/workspace/ScreenLockControl.svelte?raw";
import fileInfo from "./FileInfoBody.svelte?raw";
import inspector from "./InspectorBody.svelte?raw";

// Dashboard tab kind and carousel coverage. Pins the tab type and
// helpers, the Pane.svelte render branch, the carousel slide set,
// and command routing from the launcher/pane-menu surfaces.

describe("DashboardTab type + helpers", () => {
  test("Tab union includes DashboardTab and ExtensionTab", () => {
    expect(tabs).toMatch(
      /export type DashboardTab = \{[\s\S]{1,400}kind: "dashboard";[\s\S]{1,200}id: string;[\s\S]{1,200}title: string;/,
    );
    expect(tabs).toMatch(
      /export type Tab =\s*\n\s*\| FileTab[\s\S]{1,400}\| DashboardTab\s*\n\s*\| ExtensionTab;/,
    );
  });

  test("openDashboardInPane appends a Dashboard tab + activates it", () => {
    expect(tabs).toMatch(
      /export function openDashboardInPane\(\s*paneId: string,\s*opts\?: OpenDashboardOptions,\s*\): void \{[\s\S]{1,500}const side = opts\?\.side \?\? paneSide\(node\);[\s\S]{1,160}const tabs = mutablePaneTabs\(node, side\);[\s\S]{1,500}tabs\.push\(tab\);[\s\S]{1,200}setPaneActiveTabId\(node, tab\.id, side\);[\s\S]{1,120}node\.side = side;/,
    );
  });

  test("openDashboardInActivePane delegates to openDashboardInPane(layout.activePaneId, opts)", () => {
    expect(tabs).toMatch(
      /export function openDashboardInActivePane\(opts\?: OpenDashboardOptions\): void \{[\s\S]{1,200}openDashboardInPane\(layout\.activePaneId, opts\);/,
    );
  });

  test("openIndexingDashboard opens the Search slide (1) with auto-rotate off", () => {
    // Target of the AppStatusBar indexing pill click: jump straight to the
    // live Indexing graph, paused so it does not rotate away.
    expect(tabs).toMatch(/export const DASHBOARD_SEARCH_SLIDE = 1;/);
    expect(tabs).toMatch(
      /export function openIndexingDashboard\(\): void \{[\s\S]{1,200}slide: DASHBOARD_SEARCH_SLIDE,[\s\S]{1,80}autoRotate: false,/,
    );
  });

  test("tabLabel handles dashboard kind", () => {
    expect(tabs).toMatch(
      /export function tabLabel\(t: Tab, ctx\?: BrowserLabelCtx\): string \{[\s\S]{1,800}if \(t\.kind === "dashboard"\) return t\.title;/,
    );
  });

  test("serializer emits k:\"d\" for dashboard tabs", () => {
    expect(tabs).toMatch(
      /if \(t\.kind === "dashboard"\) \{[\s\S]{1,200}k: "d",/,
    );
  });

  test("SerTab kind discriminator includes dashboard and extension", () => {
    expect(tabs).toMatch(
      /k\?: "f" \| "b" \| "s" \| "g" \| "h" \| "t" \| "d" \| "x";/,
    );
  });
});

describe("Pane.svelte render branch + import", () => {
  test("DashboardTab imported", () => {
    expect(pane).toMatch(
      /import DashboardTab from "\.\/DashboardTab\.svelte";/,
    );
  });

  test("DashboardTab is kept mounted via the keep-alive each-loop with an active gate", () => {
    // Keep-alive (mirrors graph/file/terminal): the dashboard stays mounted
    // across tab switches so the Indexing graph keeps its layout + poll
    // state instead of reloading. The live DashboardTab proxy is threaded
    // through so the carousel slide cursor round-trips into the session
    // serializer; the `active` gate hides it + pauses the carousel/poll
    // when it is not the active tab on the visible side.
    expect(pane).toMatch(
      /\{#each everyTab\.filter\(\(t\) => t\.kind === "dashboard"\) as t \(t\.id\)\}[\s\S]{1,400}<DashboardTab[\s\S]{1,200}tab=\{t\}[\s\S]{1,200}active=\{isLiveActive\(t\)\}/,
    );
    // No active-tab if-chain arm mounts the dashboard off `active` (which
    // would remount it on every switch).
    expect(pane).not.toMatch(/<DashboardTab\s+tab=\{active\}/);
  });
});

describe("Dashboard command wiring", () => {
  test("app.dashboard.open command routed to openDashboardInActivePane", () => {
    expect(app).toMatch(
      /case "app\.dashboard\.open":[\s\S]{1,400}openDashboardInActivePane\(\);/,
    );
  });

  test("Dashboard is no longer duplicated through pane spawnActions", () => {
    expect(pane).not.toMatch(/const FULL_SPAWN_ACTIONS:/);
    expect(pane).not.toMatch(/spawnActions/);
    expect(pane).not.toMatch(/command: "app\.dashboard\.open"/);
  });
});

describe("carousel slide 1", () => {
  // App spawns live in the pane hamburger's Apps rows and the command
  // launcher, not the carousel. The carousel is a pure rotating widget
  // hosted inside the Dashboard tab.
  test("spawn entries no longer surface in the carousel", () => {
    expect(carousel).not.toMatch(/const spawnEntries: SpawnRow\[\]/);
    expect(carousel).not.toMatch(/const secondaryEntries: SpawnRow\[\]/);
    expect(carousel).not.toMatch(/function dispatchSpawn\(/);
  });

  test("welcome chrome (logo / dashboard / spawn-row) dropped from carousel markup", () => {
    expect(carousel).not.toMatch(/class="placeholder-mark"/);
    expect(carousel).not.toMatch(/class="dashboard-header"/);
    expect(carousel).not.toMatch(/<div class="spawn-row"/);
  });
});

describe("carousel slides", () => {
  test("slide 2 is the About widget", () => {
    expect(carousel).toMatch(
      /<div class="slide slide-about" aria-label="About">/,
    );
    expect(carousel).toMatch(/chan version/);
    // The embeddings / hybrid-search status row lives in Settings > This
    // workspace; the About card no longer renders it. Match the visible label
    // text, not source comments that explain the move.
    expect(carousel).not.toMatch(/>embeddings</);
    expect(carousel).not.toMatch(/features\.embeddings/);
    // The third-party font + screensaver attributions were dropped from
    // the About slide; only the version / build rows and the website /
    // source links remain.
    expect(carousel).not.toMatch(/Source Code Pro Regular/);
    expect(carousel).not.toMatch(/dcragusa\/MatrixScreensaver/);
    expect(carousel).not.toMatch(/about-licenses/);
  });

  test("About widget loads buildInfo from the typed API", () => {
    expect(carousel).toMatch(
      /let buildInfo = \$state<BuildInfo \| null>\(null\)/,
    );
    expect(carousel).toMatch(/buildInfo = await api\.buildInfo\(\)/);
  });

  test("About widget embeds the donation QR + Fund-the-work copy", () => {
    // withTokenQuery wraps the QR image path so the bearer token and
    // prefix rewrite apply under non-root mounts; a bare path would
    // render broken.
    expect(carousel).toMatch(/src=\{withTokenQuery\("\/qr-donate\.png"\)\}/);
    expect(carousel).toMatch(
      /import \{[\s\S]{1,200}withTokenQuery[\s\S]{1,200}\} from "\.\.\/api\/transport"/,
    );
    expect(carousel).toMatch(/Fund the work/);
    // "Share the love, cheers!" tail on the Fund-the-work copy.
    expect(carousel).toMatch(
      /Chan is independent software\. Small tips help cover time[\s\S]{1,40}spent on releases, packaging, and documentation\.[\s\S]{1,40}Share the love, cheers!/,
    );
  });

  test("the version row carries the build id and no license link", () => {
    // The About grid mirrors the native About window: a `chan version` row
    // followed by a `build` row carrying the binary's build id, so two builds
    // of one version are distinguishable from the dashboard.
    expect(carousel).toMatch(
      /<span class="k">chan version<\/span>\s*<span class="v mono">\{buildInfo\?\.version \?\? "n\/a"\}<\/span>/,
    );
    expect(carousel).toMatch(
      /<span class="k">build<\/span>\s*<span class="v mono">\{buildInfo\?\.build \?\? "n\/a"\}<\/span>/,
    );
    // No license link on this surface: the LICENSE anchor and the styling that
    // carried it are both gone.
    expect(carousel).not.toMatch(/LICENSE/);
    expect(carousel).not.toMatch(/Apache/);
    expect(carousel).not.toMatch(/version-license/);
    // No `.about-licenses` block (markup or CSS) and no attributions.
    expect(carousel).not.toMatch(/about-licenses/);
    expect(carousel).not.toMatch(/<span class="k">terminal font<\/span>/);
    expect(carousel).not.toMatch(/<span class="k">matrix screen lock<\/span>/);
    expect(carousel).not.toMatch(/<span class="k">chan<\/span>/);
    // The separator below the Fund-the-work QR stays.
    expect(carousel).toMatch(/\.about-sep \{[\s\S]{1,400}background: var\(--border\)/);
  });

  test("About widget shows the free/open-source tagline below the separator", () => {
    // The credits block sits after the Fund-the-work QR + the
    // `.about-sep`, and is just the free/open-source tagline; the
    // dependency list was dropped (too much for the About page) and the
    // third-party attributions were later removed too.
    expect(carousel).toMatch(
      /<div class="about-fund">[\s\S]{1,2000}<div class="about-sep"[\s\S]{1,400}<div class="about-credits">/,
    );
    expect(carousel).toMatch(
      /Built on a strong open-source foundation\. Chan is free and[\s\S]{1,20}open-source software\./,
    );
    // The dependency list (and any mermaid mirror) is gone after the trim.
    expect(carousel).not.toContain('class="credits-list"');
    expect(carousel).not.toContain("mermaid-cjv.pages.dev");
  });

  test("About widget renders icon-linked website + source links", () => {
    expect(carousel).toMatch(/href="https:\/\/chan\.app"/);
    expect(carousel).toMatch(
      /href="https:\/\/github\.com\/fiorix\/chan"/,
    );
    expect(carousel).toMatch(
      /import \{[\s\S]{1,300}Code2,[\s\S]{1,300}Globe,[\s\S]{1,200}\} from "lucide-svelte"/,
    );
  });

  test("slide 0 mounts WorkspaceInfoBody", () => {
    expect(carousel).toMatch(
      /import WorkspaceInfoBody from "\.\/WorkspaceInfoBody\.svelte";/,
    );
    // variant="dashboard" drops the directory action row; the
    // per-workspace config lives on the slot's flip-back now.
    expect(carousel).toMatch(
      /<div class="slide slide-workspace" aria-label="Workspace info">[\s\S]{1,400}<WorkspaceInfoBody[\s\S]{1,200}variant="dashboard"/,
    );
  });

  test("Shortcuts slide + workspace-metadata slide are removed", () => {
    expect(carousel).not.toMatch(/class="slide slide-shortcuts"/);
    expect(carousel).not.toMatch(/class="slide slide-metadata"/);
    expect(carousel).not.toMatch(/<pre class="shortcuts-table">/);
    expect(carousel).not.toMatch(/renderTable\(platform, os\)/);
    expect(carousel).not.toMatch(/from "\.\.\/state\/shortcuts"/);
  });

  test("slide 1 is the read-only, spine-only indexing graph", () => {
    expect(carousel).toMatch(/class="slide slide-indexing"/);
    // No inspector / scope picker / depth slider / filter chips; the
    // slide is a pure status read-out.
    expect(carousel).toMatch(/aria-label="Indexing graph"/);
  });

  test("indexing slide maximises to the tab width/height with a 10px border", () => {
    // About + Workspace read well in the 720px column; the indexing
    // graph needs the full tab area so the spine does not compress.
    // slide-stage-wide drops the max-width cap; carousel-wide tightens
    // padding to ~10px so the canvas reads edge-to-edge.
    expect(carousel).toMatch(
      /class="slide-stage" class:slide-stage-wide=\{slideIndex === 1\}/,
    );
    expect(carousel).toMatch(
      /class="carousel"\s*\n\s*class:carousel-wide=\{slideIndex === 1\}/,
    );
    expect(carousel).toMatch(
      /\.slide-stage-wide \{[\s\S]{1,200}max-width: none;/,
    );
    expect(carousel).toMatch(
      /\.carousel-wide \{[\s\S]{1,200}padding: 10px;/,
    );
  });

  test("indexing slide tracks a selectedIndexId so GraphCanvas labels selection + 1-hop", () => {
    // Clicks update selectedIndexId which feeds into GraphCanvas.selectedId,
    // labelling the selected node and its 1-hop neighbours.
    expect(carousel).toMatch(
      /let selectedIndexId = \$state<string \| null>\(null\);/,
    );
    expect(carousel).toMatch(
      /function onIndexingSelect\(id: string \| null\): void \{[\s\S]{1,200}selectedIndexId = id;/,
    );
    expect(carousel).toMatch(
      /<GraphCanvas[\s\S]{1,800}selectedId=\{selectedIndexId\}[\s\S]{1,200}onSelect=\{onIndexingSelect\}/,
    );
  });

  test("slide-stage scroll lives at the slide level for carousel resize", () => {
    expect(carousel).toMatch(/\.slide\s*\{[\s\S]{1,500}overflow-y: auto/);
    expect(carousel).toMatch(/\.carousel\s*\{[\s\S]{1,400}min-height: 0/);
  });
});

describe("DashboardTab mounts the carousel", () => {
  test("DashboardTab imports + mounts EmptyPaneCarousel + threads tab.carouselSlide", () => {
    expect(dashboard).toMatch(
      /import EmptyPaneCarousel from "\.\/EmptyPaneCarousel\.svelte";/,
    );
    // The persisted slide cursor + write-back callback survive a reload.
    // The carousel is controlled now (`slide` prop, not a one-shot
    // `initialSlide` snapshot) so the front dots and the flip-back slot
    // picker share tab.carouselSlide as the single source of truth.
    expect(dashboard).toMatch(
      /<EmptyPaneCarousel[\s\S]{1,400}slide=\{tab\.carouselSlide \?\? 0\}[\s\S]{1,200}onSlideChange=\{onCarouselSlideChange\}/,
    );
    expect(dashboard).toMatch(
      /import \{[\s\S]{1,400}scheduleSessionSave[\s\S]{1,200}\} from "\.\.\/state\/store\.svelte"/,
    );
    expect(dashboard).toMatch(/type DashboardTab/);
    expect(dashboard).toMatch(
      /function onCarouselSlideChange\(i: number\): void \{[\s\S]{1,400}tab\.carouselSlide = i;[\s\S]{1,200}scheduleSessionSave\(\);/,
    );
  });

  test("static ASCII pre + Shortcuts header dropped", () => {
    expect(dashboard).not.toMatch(/<pre class="info-shortcuts">/);
    expect(dashboard).not.toMatch(/renderTable\(platform, os\)/);
  });

  test("body wraps the carousel in a labeled region", () => {
    expect(dashboard).toMatch(
      /class="dashboard"[\s\S]{1,120}aria-label="Dashboard"[\s\S]{1,120}role="region"/,
    );
  });
});

describe("Dashboard back card is per-slot (DashboardSlotBack)", () => {
  test("DashboardTab right-click menu lists slot toggles + Flip + Reload", () => {
    // The body right-click menu carries a per-slot on/off checkbox row,
    // a separator, a Flip row that switches pane side, and Reload.
    expect(dashboard).toMatch(/import HamburgerMenu from "\.\/HamburgerMenu\.svelte";/);
    expect(dashboard).toMatch(/function onContextMenu\(e: MouseEvent\): void/);
    expect(dashboard).toMatch(/menu\?\.openAtCursor\(e\.clientX, e\.clientY\)/);
    expect(dashboard).toMatch(
      /import \{[^}]*\bRefreshCw\b[^}]*\} from "lucide-svelte"/,
    );
    // Slot helpers + flipHybrid come from tabs.svelte.
    expect(dashboard).toMatch(
      /import \{[\s\S]{1,400}dashboardSlotEnabled,[\s\S]{1,200}toggleDashboardSlot,[\s\S]{1,120}\} from "\.\.\/state\/tabs\.svelte"/,
    );
    expect(dashboard).toMatch(
      /import \{[\s\S]{1,400}\bflipHybrid\b[\s\S]{1,200}\} from "\.\.\/state\/tabs\.svelte"/,
    );
    // One checkbox row per carousel slide, driven by the tab helpers.
    expect(dashboard).toMatch(
      /const SLOTS = \["Workspace", "Search", "About"\] as const;/,
    );
    expect(dashboard).toMatch(
      /\{#each SLOTS as label, i\}[\s\S]{1,400}role="menuitemcheckbox"[\s\S]{1,160}aria-checked=\{dashboardSlotEnabled\(tab, i\)\}[\s\S]{1,160}onclick=\{\(\) => onSlotToggle\(i\)\}/,
    );
    expect(dashboard).toMatch(
      /function onSlotToggle\(i: number\): void \{[\s\S]{1,200}toggleDashboardSlot\(tab, i\);/,
    );
    // Flip switches the active pane side via flipHybrid.
    expect(dashboard).toMatch(
      /function doSettings\(\): void \{[\s\S]{1,200}flipHybrid\(layout\.activePaneId\);/,
    );
    expect(dashboard).toMatch(
      /onclick=\{doSettings\}[\s\S]{1,200}<span class="menu-row-label">Flip<\/span>[\s\S]{1,200}chordLabel\("app\.pane\.flip"\)/,
    );
    // Reload stays.
    expect(dashboard).toMatch(
      /import \{\s*reloadWindow\s*\} from "\.\.\/api\/desktop";/,
    );
    expect(dashboard).toMatch(/async function doReload\(\): Promise<void>/);
    expect(dashboard).toMatch(
      /onclick=\{doReload\}[\s\S]{1,200}<RefreshCw[\s\S]{1,200}<span class="menu-row-label">Reload<\/span>[\s\S]{1,160}<span class="menu-row-chord">\{chordLabel\("app\.window\.reload"\)\}<\/span>/,
    );
  });

  test("DashboardSlotBack wraps the shared shell + dispatches one body per slot", () => {
    // Same shell every other Hybrid back uses, titled by the active slot.
    // Only the Workspace slot still has body content: read-only recent
    // workspaces.
    expect(dashboardBack).toMatch(
      /<HybridSurfaceConfigShell[\s\S]{1,200}title=\{SLOTS\[slot\]\}[\s\S]{1,200}ariaLabel="Dashboard settings"[\s\S]{1,120}\{onDone\}/,
    );
    expect(dashboardBack).toMatch(
      /const SLOTS = \["Workspace", "Search", "About"\] as const;/,
    );
    expect(dashboardBack).toMatch(
      /\{#if slot === 0\}[\s\S]{1,80}<WorkspaceSlotConfig \/>[\s\S]{1,80}\{\/if\}/,
    );
    expect(dashboardBack).not.toMatch(/SearchSlotConfig/);
    expect(dashboardBack).not.toMatch(/AboutSlotConfig/);
    // Picking a slot moves the shared carousel cursor so the front
    // carousel lands on the same slot on flip-back.
    expect(dashboardBack).toMatch(/tab\.carouselSlide = i;/);
    // The shared shell still owns the OK button.
    expect(shell).toMatch(
      /<button type="button" class="config-ok" onclick=\{\(\) => onDone\?\.\(\)\}>OK<\/button>/,
    );
  });

  test("migrated workspace controls live in Settings, not Dashboard backs", () => {
    expect(workspaceSlot).toMatch(/<h3>Workspaces<\/h3>/);
    expect(workspaceSlot).toMatch(/globalConfig\?\.workspaces/);
    expect(workspaceSlot).not.toMatch(/<h3>chan-reports<\/h3>/);
    expect(workspaceSlot).not.toMatch(/<h3>Metadata archive<\/h3>/);
    expect(workspaceSlot).not.toMatch(/api\.metadataExport\(\)/);
    expect(workspaceSlot).not.toMatch(/api\.metadataImport/);
    expect(workspaceSlot).not.toMatch(/api\.reportsEnable\(\)/);

    expect(indexControl).toMatch(/api\.indexRebuild\(\)/);
    expect(semanticControl).toMatch(/api\.semanticEnable\(\)/);
    expect(semanticControl).toMatch(/api\.semanticModelPatch\(model\)/);
    expect(excludedDirsControl).toMatch(/api\.setExcludedDirs\(additions\)/);
    expect(reportsControl).toMatch(/api\.reportsEnable\(\)/);
    expect(metadataControl).toMatch(/api\.metadataExport\(\)/);
    expect(metadataControl).toMatch(/api\.metadataImport\(metadataImportFile/);
    expect(screenLockControl).toMatch(/api\.screensaverState\(\)/);
  });

  test("Pane.svelte does not mount DashboardSlotBack", () => {
    expect(pane).not.toMatch(
      /import DashboardSlotBack from "\.\/dashboard\/DashboardSlotBack\.svelte";/,
    );
    expect(pane).not.toMatch(/<DashboardSlotBack/);
  });
});

describe("EmptyPaneWelcome empty-pane surface", () => {
  test("EmptyPaneWelcome starts randomly and keeps every animation optional", async () => {
    const welcome = (await import("./EmptyPaneWelcome.svelte?raw"))
      .default as string;
    // The surface is the mark over one decorative field and its transient
    // catalog name, with no actions of its own.
    expect(welcome).toMatch(
      /\{#key markCycle\}[\s\S]{1,80}class="welcome-mark"/,
    );
    expect(welcome).toMatch(
      /opacity: 0;[\s\S]{1,60}animation: empty-pane-mark-flash 1\.8s ease-in-out;/,
    );
    expect(welcome).toMatch(/animation = initialEmptyPaneAnimation\(\)/);
    expect(welcome).toMatch(/persistEmptyPaneAnimation\(next\)/);
    expect(welcome).toMatch(
      /animationNameFlash = emptyPaneAnimationName\(next\)/,
    );
    expect(welcome).toMatch(
      /class="animation-name-flash"[\s\S]{1,180}\{animationNameFlash\}/,
    );
    expect(welcome).toMatch(
      /bottom: clamp\(24px, 6%, 64px\);[\s\S]{1,500}animation: empty-pane-animation-name-flash 1100ms ease-in-out;/,
    );
    expect(welcome).not.toMatch(/<svelte:window/);
    expect(welcome).toMatch(
      /class="welcome"[\s\S]{1,180}onkeydown=\{onAnimationKeyDown\}/,
    );
    expect(welcome).toMatch(
      /key === "ArrowRight"[\s\S]{1,180}stepEmptyPaneAnimation\(animation, 1\)/,
    );
    expect(welcome).toMatch(
      /key === "ArrowLeft"[\s\S]{1,180}stepEmptyPaneAnimation\(animation, -1\)/,
    );
    expect(welcome).toMatch(
      /key === "ArrowUp"[\s\S]{1,80}selectSpeed\(1\)/,
    );
    expect(welcome).toMatch(
      /key === "ArrowDown"[\s\S]{1,80}selectSpeed\(-1\)/,
    );
    expect(welcome).toMatch(
      /else[\s\S]{1,180}randomEmptyPaneAnimation\(animation\)/,
    );
    expect(welcome).toMatch(
      /const ANIMATION_COMPONENTS = \{[\s\S]{1,1800}satisfies Record<EmptyPaneAnimationId, Component>;/,
    );
    expect(welcome).toMatch(/"dotted-waves": DottedSurface/);
    expect(welcome).toMatch(/"exponential-echo": ExponentialEcho/);
    expect(welcome).toMatch(/"chaotic-halo": ChaoticHalo/);
    expect(welcome).toMatch(/"lorenz-constellation": LorenzConstellation/);
    expect(welcome).toMatch(/"hexagonal-bloom": HexagonalBloom/);
    expect(welcome).toMatch(/"turbulent-oculus": TurbulentOculus/);
    expect(welcome).toMatch(/"stellar-outburst": StellarOutburst/);
    expect(welcome).toMatch(/"amber-recursion": AmberRecursion/);
    expect(welcome).toMatch(/<ActiveAnimation \/>/);
    expect(welcome).not.toMatch(/workspace\.info/);
    expect(welcome).not.toMatch(/welcome-name/);
    expect(welcome).not.toMatch(/welcome-header/);
    // Short panes hide the mark via a container query on the surface
    // itself, so the rule is pane-aware in splits.
    expect(welcome).toMatch(/container-type: size;/);
    expect(welcome).toMatch(
      /@container \(max-height: 420px\) \{[\s\S]{1,120}\.welcome-mark \{[\s\S]{1,60}display: none;/,
    );
    // App spawns live in the pane hamburger's Apps rows (Pane.svelte)
    // and the command launcher; the welcome surface owns no button,
    // menu, or command dispatch of its own.
    expect(welcome).not.toMatch(/welcome-apps/);
    expect(welcome).not.toMatch(/HamburgerMenu/);
    expect(welcome).not.toMatch(/chan:command/);
    expect(welcome).not.toMatch(/appRows/);
    expect(welcome).not.toMatch(/chordLabel/);
    expect(welcome).not.toMatch(/lucide-svelte/);
    // New workspace windows should stay quiet until the user explicitly
    // opens the launcher from a menu or global chord.
    expect(welcome).not.toMatch(/openCommandLauncher/);
    expect(welcome).not.toMatch(/onMount/);
    expect(welcome).not.toMatch(/spawn-row/);
    expect(welcome).not.toMatch(/SpawnRow/);
    expect(welcome).not.toMatch(/spawn-chord/);
    expect(welcome).not.toMatch(/class="welcome-hint"/);
  });

  test("pane hamburger owns the Apps rows, alphabetical by title", () => {
    // The Apps rows moved from the welcome surface into the pane
    // hamburger; they dispatch the same spawn command ids through
    // chan:command with their chord labels.
    const rowIds = [...pane.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
    expect(rowIds).toEqual([
      "app.dashboard.open",
      "app.diagram.new",
      "app.draft.new",
      "app.files.toggle",
      "app.graph.toggle",
      "app.slides.new",
      "app.terminal.teamWork",
      "app.terminal.toggle",
    ]);
    // `...extra` carries per-command payload (the shell picker sends a
    // `profile`); the pin is that every row still routes through this one
    // dispatcher rather than reimplementing the action.
    expect(pane).toMatch(
      /new CustomEvent\("chan:command", \{ detail: \{ name: id, \.\.\.extra \} \}\)/,
    );
    expect(pane).toMatch(/\{chordLabel\(row\.id\)\}/);
  });

  test("shell profiles render under New terminal in BOTH window kinds", async () => {
    const pane = (await import("./Pane.svelte?raw")).default as string;

    // Indented siblings of the "New terminal" row, not a submenu and not a
    // separate button in the pane's action strip.
    expect(pane).toMatch(/\{#snippet terminalProfileRows\(\)\}/);
    expect(pane).toMatch(/class="menu-row-indent"/);
    expect(pane).not.toMatch(/new-term-split/);

    // Workspace window: rendered inside the appRows loop, keyed off the
    // terminal row so it stays attached if the table is reordered.
    expect(pane).toMatch(
      /row\.id === "app\.terminal\.toggle"\s*\}\s*\n\s*\{@render terminalProfileRows\(\)\}/,
    );

    // Terminal-only window: the hardcoded row's own render, so a standalone
    // terminal window gets the same picker.
    const standalone = pane.slice(pane.indexOf("window-mode gate allows"));
    expect(standalone).toMatch(/\{@render terminalProfileRows\(\)\}/);

    // Both renders exist; neither was dropped when the other was edited.
    expect([...pane.matchAll(/\{@render terminalProfileRows\(\)\}/g)]).toHaveLength(2);
  });

  test("chordless Apps spawns route through runCommand for the hamburger menu", () => {
    // The hamburger rows dispatch chan:command for every id; the two
    // catalog-only spawns need their runCommand cases to land anywhere.
    expect(app).toMatch(
      /case "app\.diagram\.new":[\s\S]{1,120}createDiagramAndOpen\(\);/,
    );
    expect(app).toMatch(
      /case "app\.slides\.new":[\s\S]{1,120}createSlidesAndOpen\(\);/,
    );
  });

  test("Pane.svelte mounts EmptyPaneWelcome only when the lone pane has no tabs", async () => {
    const pane = (await import("./Pane.svelte?raw")).default as string;
    expect(pane).toMatch(
      /import EmptyPaneWelcome from "\.\/EmptyPaneWelcome\.svelte";/,
    );
    // EmptyPaneWelcome mounts only on the completely empty lone-pane case:
    // not in a split, a terminal-only window, or while a tab remains on the
    // hidden Hybrid side.
    // EmptyPaneWelcome does not forward oncontextmenu because there
    // is no empty-pane right-click menu.
    expect(pane).toMatch(
      /\{#if !multiPane && !ui\.terminalOnly && everyTab\.length === 0\}[\s\S]{1,800}<EmptyPaneWelcome \/>/,
    );
    expect(pane).not.toMatch(/<EmptyPaneWelcome oncontextmenu=/);
    // EmptyPaneCarousel is owned by DashboardTab.svelte, not Pane.svelte.
    expect(pane).not.toMatch(
      /import EmptyPaneCarousel from "\.\/EmptyPaneCarousel\.svelte";/,
    );
  });

  test("DottedSurface sizing ignores transient flip transforms", async () => {
    const dotted = (await import("./DottedSurface.svelte?raw"))
      .default as string;
    const lifecycle = (await import("./canvasAnimation.ts?raw"))
      .default as string;
    expect(dotted).toMatch(/runCanvasAnimation\(host/);
    expect(lifecycle).toMatch(/canvas\.clientWidth/);
    expect(lifecycle).toMatch(/canvas\.clientHeight/);
    expect(lifecycle).not.toMatch(/canvas\.getBoundingClientRect\(\)/);
    expect(dotted).toMatch(/const HORIZON_RATIO = -0\.05;/);
    expect(dotted).toMatch(/height: clamp\(260px, 33%, 400px\);/);
    expect(dotted).toMatch(/bottom: 0;/);
    expect(dotted).not.toMatch(/mask-image/);
  });
});

describe("Dashboard slot on/off helpers + persistence", () => {
  test("DashboardTab carries an optional disabledSlots set", () => {
    expect(tabs).toMatch(/disabledSlots\?: number\[\];/);
  });

  test("DASHBOARD_SLOT_COUNT + slot helpers are exported", () => {
    expect(tabs).toMatch(/export const DASHBOARD_SLOT_COUNT = 3;/);
    expect(tabs).toMatch(
      /export function dashboardSlotEnabled\(tab: DashboardTab, i: number\): boolean \{[\s\S]{1,200}!\(tab\.disabledSlots \?\? \[\]\)\.includes\(i\)/,
    );
    expect(tabs).toMatch(
      /export function firstEnabledSlot\(tab: DashboardTab\): number/,
    );
    expect(tabs).toMatch(
      /export function nextEnabledSlot\(tab: DashboardTab, from: number\): number/,
    );
  });

  test("toggleDashboardSlot refuses the last enabled slot + clears when all-on", () => {
    expect(tabs).toMatch(
      /export function toggleDashboardSlot\(tab: DashboardTab, i: number\): void \{[\s\S]{1,400}if \(DASHBOARD_SLOT_COUNT - disabled\.size <= 1\) return;[\s\S]{1,160}disabled\.add\(i\);/,
    );
    expect(tabs).toMatch(
      /tab\.disabledSlots = next\.length > 0 \? next : undefined;/,
    );
  });

  test("serializer emits ds only when the disabled set is non-empty", () => {
    expect(tabs).toMatch(/ds\?: number\[\];/);
    expect(tabs).toMatch(
      /if \(t\.kind === "dashboard"\) \{[\s\S]{1,600}\.\.\.\(t\.disabledSlots && t\.disabledSlots\.length > 0[\s\S]{1,80}\? \{ ds: t\.disabledSlots \}/,
    );
  });

  test("restore reads ds + clamps carouselSlide off a disabled slot", () => {
    // The dashboard restore constructor (shared by restoreLayout and
    // reconcileLayout) owns the ds sanitize + slide clamp.
    expect(tabs).toMatch(
      /function restoreDashboardTabFromSer\(sertab: SerTab\): DashboardTab \{[\s\S]{1,1400}dashboardSlotEnabled\(tab, want\)[\s\S]{1,80}\? want[\s\S]{1,80}: firstEnabledSlot\(tab\)/,
    );
  });

  test("carousel skips disabled slots in auto-rotate + dots", () => {
    expect(carousel).toMatch(/disabledSlots = \[\],/);
    expect(carousel).toMatch(/function nextEnabled\(from: number\): number/);
    // Auto-rotate advances to the next ENABLED slot.
    expect(carousel).toMatch(
      /setInterval\(\(\) => \{[\s\S]{1,120}onSlideChange\?\.\(nextEnabled\(slideIndex\)\);/,
    );
    // Pagination dots iterate the enabled slot set, not a fixed range.
    expect(carousel).toMatch(/\{#each enabledSlots as i \(i\)\}/);
    // slideIndex clamps off a disabled slot to the first enabled one.
    expect(carousel).toMatch(
      /const slideIndex = \$derived\.by\(\(\) => \{[\s\S]{1,240}slotEnabled\(clamped\) \? clamped : firstEnabled\(\)/,
    );
    // DashboardTab threads the per-tab set into the carousel.
    expect(dashboard).toMatch(/disabledSlots=\{tab\.disabledSlots \?\? \[\]\}/);
  });
});

describe("Search-slot directory inspector actions", () => {
  test("FileInfoBody gates Upload on allowUpload + adds a directory New Terminal", () => {
    expect(fileInfo).toMatch(/onNewTerminal\?: \(\) => void;/);
    expect(fileInfo).toMatch(/allowUpload\?: boolean;/);
    expect(fileInfo).toMatch(/allowUpload = true,/);
    // Upload is a directory dropdown action, gated behind allowUpload: the
    // prop feeds the shared classifier as a capability, and the row it
    // unlocks binds triggerUpload.
    expect(fileInfo).toMatch(/upload: allowUpload,/);
    expect(fileInfo).toMatch(
      /case "upload":[\s\S]{1,120}label: "Upload file here",[\s\S]{1,80}onClick: triggerUpload/,
    );
    // Download is always offered (tarball for dirs, "Download file" otherwise).
    expect(fileInfo).toMatch(/onClick: downloadSelection,/);
    // "New terminal here" prefers the host handler, else seeds via fromHere.
    expect(fileInfo).toMatch(
      /label: "New terminal here",[\s\S]{1,40}onClick: newTerminalHere\s*[},]/,
    );
    expect(fileInfo).toMatch(
      /function newTerminalHere\(\): void \{[\s\S]{1,120}if \(onNewTerminal\) \{[\s\S]{1,60}onNewTerminal\(\);[\s\S]{1,160}terminalFromHereTarget\(entry\.path, entry\.is_dir\)/,
    );
  });

  test("InspectorBody forwards onNewTerminal + allowUpload to the directory body", () => {
    expect(inspector).toMatch(/onNewTerminal,/);
    expect(inspector).toMatch(/allowUpload = true,/);
    // Directory arm forwards both; file arm forwards allowUpload.
    expect(inspector).toMatch(
      /\{onSetAsScope\}\s*\n\s*\{onNewTerminal\}\s*\n\s*\{allowUpload\}/,
    );
    expect(inspector).toMatch(/\{onSetAsScope\}\s*\n\s*\{allowUpload\}\s*\n\s*\{showRefs\}/);
  });

  test("index-graph slide binds the dir helpers + suppresses Upload", () => {
    expect(carousel).toMatch(/allowUpload=\{false\}/);
    expect(carousel).toMatch(
      /onReveal=\{\(\) => \{[\s\S]{1,200}revealPathInBrowser\(selectedIndexPath, \{/,
    );
    expect(carousel).toMatch(
      /onSetAsScope=\{\(\) => \{[\s\S]{1,200}openFsGraphForDirectory\(selectedIndexPath\)/,
    );
    expect(carousel).toMatch(
      /onNewTerminal=\{\(\) => \{[\s\S]{1,260}terminalFromHereTarget\(selectedIndexPath, true\)/,
    );
    // The helpers are imported from their owning modules.
    expect(carousel).toMatch(
      /import \{ layout, openTerminalInPane \} from "\.\.\/state\/tabs\.svelte";/,
    );
    expect(carousel).toMatch(
      /import \{ terminalFromHereTarget \} from "\.\.\/terminal\/fromHere";/,
    );
  });
});

describe("Settings workspace screensaver preview reacts to theme", () => {
  test("preview switches on screensaverTheme; hint tracks the theme", () => {
    expect(screenLockControl).toMatch(
      /import PlainScreensaverPreview from "\.\.\/\.\.\/screensaver\/PlainScreensaverPreview\.svelte";/,
    );
    expect(screenLockControl).toMatch(
      /\{#if screensaverTheme === "matrix"\}[\s\S]{1,160}<MatrixRainPreview[\s\S]{1,80}\{:else\}[\s\S]{1,160}<PlainScreensaverPreview/,
    );
    expect(screenLockControl).toMatch(
      /Preview of the \{screensaverTheme === "matrix"[\s\S]{1,80}\? "Matrix"[\s\S]{1,80}: "Default"\} lock[\s\S]{1,20}theme/,
    );
    // No longer hardcoded to a Matrix-only preview + hint.
    expect(screenLockControl).not.toMatch(/Static preview of the Matrix lock theme\./);
    // The preview now lives INSIDE the Screen lock box (a div with a
    // title), not as a separate standalone <section> below it.
    expect(screenLockControl).not.toMatch(/<section class="screensaver-preview">/);
    expect(screenLockControl).toMatch(/class="preview-title">Screensaver preview</);
    // ...and only renders while the screen lock is ON (gated inside the
    // screensaverEnabled === true block).
    expect(screenLockControl).toMatch(
      /\{#if screensaverEnabled === true\}[\s\S]*?class="screensaver-preview"[\s\S]*?\{\/if\}/,
    );
  });

  test("PlainScreensaverPreview renders the enso mark on a dark backdrop", async () => {
    const plain = (
      await import("./screensaver/PlainScreensaverPreview.svelte?raw")
    ).default as string;
    expect(plain).toMatch(/chan-mark\.png/);
    expect(plain).toMatch(/background: var\(--bg\)/);
  });
});

describe("Per-tab auto-rotate opt-out", () => {
  test("DashboardTab carries optional autoRotate; serializer round-trips it as ar", () => {
    expect(tabs).toMatch(/autoRotate\?: boolean;/);
    expect(tabs).toMatch(/ar\?: boolean;/);
    expect(tabs).toMatch(
      /\.\.\.\(t\.autoRotate === false \? \{ ar: false \} : \{\}\)/,
    );
    expect(tabs).toMatch(/if \(sertab\.ar === false\) tab\.autoRotate = false;/);
  });

  test("carousel pauses auto-advance when autoRotate is false", () => {
    expect(carousel).toMatch(/autoRotate = true,/);
    expect(carousel).toMatch(/!active \|\| !autoRotate/);
    expect(dashboard).toMatch(/autoRotate=\{tab\.autoRotate \?\? true\}/);
  });
});

describe("Dashboard slot menu reachable from the tab title", () => {
  test("DashboardTab opens its menu from the shared tabMenu state", () => {
    // Pane.svelte's tab-title right-click routes every kind through
    // openTabMenu; DashboardTab translates a request targeting its tab
    // into opening the same HamburgerMenu at the click point.
    expect(dashboard).toMatch(
      /import \{ closeTabMenu, tabMenu \} from "\.\.\/state\/tabMenu\.svelte";/,
    );
    expect(dashboard).toMatch(/\$effect\(\(\) => \{/);
    expect(dashboard).toMatch(/tabMenu\.openForTabId !== tab\.id/);
    expect(dashboard).toMatch(/closeTabMenu\(\);[\s\S]{1,80}menu\.openAtCursor\(left, top\)/);
  });
});
