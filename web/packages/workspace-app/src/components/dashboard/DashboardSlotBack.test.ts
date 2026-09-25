import { describe, expect, test } from "vitest";
import dashboardBack from "./dashboard/DashboardSlotBack.svelte?raw";

// The dashboard back's slot picker is a carousel navigator - prev/next chevrons
// + a dot pager + a pause/play toggle - mirroring the front carousel's control
// affordances. Asserted as source shape because the markup is a Svelte
// component, not a pure function; the real interaction is browser-smoked.

describe("dashboard back slot selector is a carousel navigator", () => {
  test("imports the chevron + play/pause icons", () => {
    expect(dashboardBack).toMatch(
      /import \{[^}]*\bChevronLeft\b[^}]*\bChevronRight\b[^}]*\bPause\b[^}]*\bPlay\b[^}]*\} from "lucide-svelte"/,
    );
  });

  test("prev/next chevrons step the shared cursor across all three slots", () => {
    expect(dashboardBack).toMatch(
      /function step\(delta: number\): void \{[\s\S]{1,200}selectSlot\(\(slot \+ delta \+ SLOTS\.length\) % SLOTS\.length\)/,
    );
    expect(dashboardBack).toMatch(
      /class="nav-arrow"[\s\S]{1,160}onclick=\{\(\) => step\(-1\)\}[\s\S]{1,120}<ChevronLeft/,
    );
    expect(dashboardBack).toMatch(
      /class="nav-arrow"[\s\S]{1,160}onclick=\{\(\) => step\(1\)\}[\s\S]{1,120}<ChevronRight/,
    );
  });

  test("one dot per slot, active filled, selecting moves the cursor", () => {
    expect(dashboardBack).toMatch(
      /\{#each SLOTS as label, i \(label\)\}[\s\S]{1,260}class="dot-btn"[\s\S]{1,120}class:active=\{slot === i\}[\s\S]{1,200}onclick=\{\(\) => selectSlot\(i\)\}/,
    );
  });

  test("pause/play toggles the per-tab autoRotate field the front carousel reads", () => {
    expect(dashboardBack).toMatch(
      /const autoRotate = \$derived\(tab\.autoRotate \?\? true\)/,
    );
    expect(dashboardBack).toMatch(
      /function toggleAutoRotate\(\): void \{[\s\S]{1,160}tab\.autoRotate = !autoRotate;/,
    );
    expect(dashboardBack).toMatch(
      /class="cycle-toggle"[\s\S]{1,200}onclick=\{toggleAutoRotate\}[\s\S]{1,300}\{#if autoRotate\}[\s\S]{1,120}<Pause[\s\S]{1,160}<Play/,
    );
  });

  test("the nav rides the shell footer row (footerCenter), sharing it with OK", () => {
    // The nav shares the OK footer row - centered, OK pinned
    // right, no divider - via the shell's `footerCenter` snippet +
    // `footerBorder={false}`, instead of a separate centered bottom row in
    // the body above the divider. The Workspace body still renders before the nav.
    const slotIdx = dashboardBack.indexOf("<WorkspaceSlotConfig />");
    const navIdx = dashboardBack.indexOf('class="carousel-nav"');
    expect(slotIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(slotIdx);
    // The nav is the shell's footerCenter content...
    expect(dashboardBack).toMatch(
      /\{#snippet footerCenter\(\)\}[\s\S]{1,240}class="carousel-nav"/,
    );
    // ...and this back drops the footer's top divider for a seamless row.
    expect(dashboardBack).toMatch(/footerBorder=\{false\}/);
    // Row placement/centering is the footer grid's job now, so the nav no
    // longer carries its own margin-top:auto / align-self.
    expect(dashboardBack).not.toMatch(/\.carousel-nav \{[\s\S]{1,200}margin-top: auto;/);
    expect(dashboardBack).not.toMatch(/\.carousel-nav \{[\s\S]{1,200}align-self:/);
  });
});
