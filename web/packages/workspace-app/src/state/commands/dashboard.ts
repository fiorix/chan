// Dashboard surface commands: available when a dashboard tab is the
// active surface. Slide commands move the controlled carousel index on
// the active DashboardTab (its fields are $state) and persist the
// session, matching the carousel's own arrows: step next and previous, or
// jump straight to a named slide. The slides and their order are the
// dashboard menu's.
// See state/commands.ts for the Command shape and the onSurface helper.

import { openChoice, registerCommands, onSurface } from "../commands";
import { scheduleSessionSave } from "../store.svelte";
import {
  activeDashboardTab,
  DASHBOARD_SLOT_LABELS,
  DASHBOARD_SLOT_ORDER,
  dashboardSlotAvailable,
  dashboardSlotEnabled,
  firstEnabledSlot,
  nextEnabledSlot,
  prevEnabledSlot,
  toggleDashboardSlot,
  type DashboardTab,
} from "../tabs.svelte";

/// Run an action against the active dashboard tab, a no-op when none is
/// active.
function onDashboard(fn: (tab: DashboardTab) => void): () => void {
  return () => {
    const tab = activeDashboardTab();
    if (tab) fn(tab);
  };
}

/// The slides this window can show, in the dashboard menu's order. The
/// first two need a workspace; About and Metrics are offered in any window
/// that holds a Dashboard.
function availableSlots(): number[] {
  return DASHBOARD_SLOT_ORDER.filter(dashboardSlotAvailable);
}

/// The slide the carousel shows: the tab's cursor, or the first shown
/// slide while the cursor points at one switched off.
function currentSlot(tab: DashboardTab): number {
  const slide = tab.carouselSlide ?? 0;
  return dashboardSlotEnabled(tab, slide) ? slide : firstEnabledSlot(tab);
}

registerCommands([
  {
    // One row per slide with a check on each that is shown, as the
    // dashboard menu lists them. The last shown slide stays on.
    id: "app.dashboard.slides",
    title: "Shown slides",
    category: "Dashboard",
    scope: "app",
    surface: "dashboard",
    order: 0,
    kind: "choice",
    requirement: "any",
    keywords: ["slide", "carousel", "show", "hide", "rotation"],
    available: (ctx) => onSurface(ctx, "dashboard"),
    state: () => {
      const tab = activeDashboardTab();
      if (!tab) return null;
      const slots = availableSlots();
      return `${slots.filter((slot) => dashboardSlotEnabled(tab, slot)).length} of ${slots.length}`;
    },
    options: () => {
      const tab = activeDashboardTab();
      if (!tab) return [];
      return availableSlots().map((slot) => ({
        id: String(slot),
        label: DASHBOARD_SLOT_LABELS[slot],
        checked: dashboardSlotEnabled(tab, slot),
        run: () => {
          toggleDashboardSlot(tab, slot);
          // A cursor left on a slide just switched off moves to the first
          // one still shown, as the dashboard menu moves it.
          tab.carouselSlide = currentSlot(tab);
          scheduleSessionSave();
        },
      }));
    },
    run: () => openChoice("app.dashboard.slides"),
  },
  {
    // A slide the user switched off in the dashboard menu re-clamps to the
    // first shown one, matching how the persisted cursor is restored.
    id: "app.dashboard.slide",
    title: "Go to slide",
    category: "Dashboard",
    scope: "app",
    surface: "dashboard",
    kind: "choice",
    requirement: "any",
    keywords: [
      "Go to Metrics",
      "Go to Workspace status",
      "Go to Indexing status",
      "Go to About chan",
      "slide",
      "carousel",
      "jump",
    ],
    available: (ctx) => onSurface(ctx, "dashboard"),
    state: () => {
      const tab = activeDashboardTab();
      return tab ? DASHBOARD_SLOT_LABELS[currentSlot(tab)] : null;
    },
    options: () => {
      const tab = activeDashboardTab();
      if (!tab) return [];
      return availableSlots().map((slot) => ({
        id: String(slot),
        label: DASHBOARD_SLOT_LABELS[slot],
        checked: currentSlot(tab) === slot,
        run: () => {
          tab.carouselSlide = dashboardSlotEnabled(tab, slot) ? slot : firstEnabledSlot(tab);
          scheduleSessionSave();
        },
      }));
    },
    run: () => openChoice("app.dashboard.slide"),
  },
  {
    id: "app.dashboard.nextSlide",
    title: "Next slide",
    category: "Dashboard",
    scope: "app",
    surface: "dashboard",
    requirement: "any",
    keywords: ["slide", "carousel", "next", "forward"],
    available: (ctx) => onSurface(ctx, "dashboard"),
    run: onDashboard((tab) => {
      tab.carouselSlide = nextEnabledSlot(tab, tab.carouselSlide ?? 0);
      scheduleSessionSave();
    }),
  },
  {
    id: "app.dashboard.prevSlide",
    title: "Previous slide",
    category: "Dashboard",
    scope: "app",
    surface: "dashboard",
    requirement: "any",
    keywords: ["slide", "carousel", "previous", "back"],
    available: (ctx) => onSurface(ctx, "dashboard"),
    run: onDashboard((tab) => {
      tab.carouselSlide = prevEnabledSlot(tab, tab.carouselSlide ?? 0);
      scheduleSessionSave();
    }),
  },
]);
