// What the command launcher lists, built from the command catalog and the
// settings index: the sectioned list it browses, the flat ranked list a typed
// query gets, and the option lists of choices. Pure builders over a snapshot
// of the window, so each rule is checked without mounting the launcher. The
// launcher component adds what needs the window's services: icons, the
// Computers rows, which the shared Computers tree builds, and running a row.

import {
  fuzzyDeckScore,
  matchDeckItems,
  rankDeckItems,
  type DeckItem,
  type DeckMatch,
} from "@chan/web-shared/command-deck";
import type { SettingSpec } from "../../components/settings/settingsIndex";
import {
  CHOICE_LEVEL,
  PANE_GROUPS,
  SURFACE_LABELS,
  choicePath,
  commandOnActiveSurface,
  commandPlacement,
  commandUnavailableReason,
  requirementAllows,
  type Command,
  type CommandCategory,
  type CommandContext,
  type CommandOption,
  type CommandScope,
  type CommandSurface,
} from "../commands";

/// A launcher scope: where a command acts, plus the Computers scope the
/// launcher component fills.
export type DeckScopeName = CommandScope | "computers";

/// A Settings rail section, as the launcher needs it.
export type DeckSettingsSection = {
  id: string;
  label: string;
  /// The command category whose surface the section configures.
  category: CommandCategory | null;
};

/// The window as the builders read it.
export type DeckSource = {
  ctx: CommandContext;
  /// Every registered command, available or not.
  commands: readonly Command[];
  /// The focused tab's app, null with no tab.
  app: { label: string } | null;
  /// The settings index, in rail and field order.
  settings: readonly SettingSpec[];
  /// The Settings rail, in its order.
  sections: readonly DeckSettingsSection[];
  /// Command ids last run from the launcher, most recent first.
  recent: readonly string[];
  /// The chord a command id shows, null when it has none.
  chord: (id: string) => string | null;
};

/// One launcher row with what choosing it does.
export interface DeckRow extends DeckItem {
  /// The branch choosing the row opens, as a whole launcher path.
  next?: string[];
  /// The page of a row that runs when chosen, as a whole launcher path: its
  /// other actions sit there.
  page?: string[];
  /// What choosing the row runs.
  run?: () => unknown;
  /// How the launcher treats the run: `stay` leaves it open on the row, whose
  /// state the run changes; `close` dismisses it first, so what the command
  /// opens lands on top.
  after?: "stay" | "close";
  /// The command a run records as recently used.
  recent?: string;
  /// The catalog command behind the row.
  command?: Command;
}

/// The most recent commands the launcher lists.
export const RECENT_LIMIT = 5;
/// The most unavailable commands a typed query lists.
export const UNAVAILABLE_LIMIT = 5;

const RECENT_SECTION = "Recent";
const SETTINGS_LABEL = "Settings";
const SEPARATOR = " › ";
/// Where a command without an `order` sorts: after every ordered one.
const UNORDERED = 1000;

const SCOPE_LABELS: Record<Exclude<DeckScopeName, "app">, string> = {
  pane: "Pane",
  window: "Window",
  workspace: "Workspace",
  settings: SETTINGS_LABEL,
  computers: "Computers",
};

/// The surface each configurable app's Settings section answers to, by the
/// section's category.
const SURFACE_CATEGORIES: Partial<Record<CommandSurface, CommandCategory>> = {
  file: "Editor",
  terminal: "Terminal",
  browser: "File Browser",
  graph: "Graph",
  dashboard: "Dashboard",
};

function isScopeName(scope: string | null): scope is DeckScopeName {
  return scope === "app" || (scope !== null && scope in SCOPE_LABELS);
}

/// A scope's name: the focused app's for `app`, its own otherwise.
export function scopeLabel(source: DeckSource, scope: DeckScopeName): string {
  return scope === "app" ? (source.app?.label ?? "App") : SCOPE_LABELS[scope];
}

// ---- paths -------------------------------------------------------------
//
// A launcher path is a stack of levels, one string each. The builders own
// three kinds: a choice command's options (the catalog's CHOICE_LEVEL), a
// choice setting's options, and one Settings section. Any other level
// belongs to the launcher component.

const SETTING_LEVEL = "setting:";
const SECTION_LEVEL = "settings:";

function settingLevel(id: string): string {
  return `${SETTING_LEVEL}${id}`;
}

function sectionLevel(id: string): string {
  return `${SECTION_LEVEL}${id}`;
}

/// Whether the innermost level of `path` is one the builders list.
export function isCatalogPath(path: readonly string[]): boolean {
  const level = path.at(-1);
  return (
    level !== undefined &&
    (level.startsWith(CHOICE_LEVEL) ||
      level.startsWith(SETTING_LEVEL) ||
      level.startsWith(SECTION_LEVEL))
  );
}

// ---- commands ----------------------------------------------------------

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
}

/// One entry per id, the latest registration winning, so a module evaluated
/// twice cannot list a command twice.
function uniqueCommands(source: DeckSource): Command[] {
  const byId = new Map<string, Command>();
  for (const command of source.commands) byId.set(command.id, command);
  return [...byId.values()];
}

function isAvailable(source: DeckSource, command: Command): boolean {
  return requirementAllows(command.requirement, source.ctx.caps) && command.available(source.ctx);
}

/// The heading a command sits under: its group, or for an app command the
/// name of the app it belongs to.
function sectionOf(source: DeckSource, command: Command): string {
  const { scope, surfaces, group } = commandPlacement(command);
  if (group !== null) return group;
  if (scope === "app" && commandOnActiveSurface(command, source.ctx) && source.app) {
    return source.app.label;
  }
  const surface = surfaces[0];
  return surface ? SURFACE_LABELS[surface] : "App";
}

/// `Scope > Group`, with a group that only repeats its scope left out.
function breadcrumbOf(source: DeckSource, command: Command): string {
  const { scope } = commandPlacement(command);
  const section = sectionOf(source, command);
  if (scope === "app") return section;
  const lead = SCOPE_LABELS[scope];
  return section === lead ? lead : `${lead}${SEPARATOR}${section}`;
}

function stateValue(state: boolean | string | null | undefined): string | undefined {
  if (state === true) return "on";
  if (state === false) return "off";
  return state ?? undefined;
}

type CommandRowOptions = {
  /// List the row under its section heading, as browsing does.
  sectioned?: boolean;
  /// The typed remainder an `acceptsArg` command runs with.
  arg?: string;
  /// The reason an unavailable command cannot run; the row is then disabled.
  unavailable?: string;
};

function commandRow(
  source: DeckSource,
  command: Command,
  options: CommandRowOptions = {},
): DeckRow {
  const { arg, unavailable } = options;
  const { scope } = commandPlacement(command);
  const row: DeckRow = {
    id: `command:${command.id}${arg === undefined ? "" : `\u001f${arg}`}`,
    title: arg === undefined ? command.title : `${command.title.replace(/\.+$/, "")} ${arg}`,
    breadcrumb: breadcrumbOf(source, command),
    searchText: [command.title, ...(command.keywords ?? []), command.category, arg ?? ""].join(" "),
    scope,
    shortcut: source.chord(command.id),
    command,
  };
  if (options.sectioned) row.section = sectionOf(source, command);
  if (command.confirm?.danger) row.danger = true;
  if (unavailable !== undefined) {
    row.disabled = true;
    row.subtitle = unavailable;
    return row;
  }
  const state = command.state?.(source.ctx);
  row.value = stateValue(state);
  if (command.kind === "choice") {
    row.kind = "choice";
    row.next = choicePath(command.id);
    return row;
  }
  row.confirm = command.confirm;
  row.recent = command.id;
  if (command.state) {
    // A command that reports its state changes in place.
    row.kind = command.kind === "toggle" ? "toggle" : "action";
    row.after = "stay";
    row.run = () => command.run();
  } else {
    row.kind = "action";
    row.after = "close";
    row.run = () => command.run(arg);
  }
  return row;
}

function optionRow(
  source: DeckSource,
  command: Command,
  option: CommandOption,
  leaf: boolean,
): DeckRow {
  const breadcrumb = breadcrumbOf(source, command);
  return {
    id: `command:${command.id}=${option.id}`,
    title: leaf ? `${command.title}: ${option.label}` : option.label,
    breadcrumb: leaf ? breadcrumb : `${breadcrumb}${SEPARATOR}${command.title}`,
    searchText: [command.title, option.label, ...(command.keywords ?? [])].join(" "),
    scope: commandPlacement(command).scope,
    checked: option.checked,
    kind: "action",
    after: option.dismiss ? "close" : "stay",
    recent: command.id,
    run: option.run,
    command,
  };
}

/// Commands of one scope that can run now, each under its section, in the
/// order the launcher lists them: sections in the scope's order, then
/// `order`, then title.
function scopeRows(source: DeckSource, scope: CommandScope): DeckRow[] {
  const rank = (section: string): number => {
    const index = (PANE_GROUPS as readonly string[]).indexOf(section);
    return index < 0 ? PANE_GROUPS.length : index;
  };
  return uniqueCommands(source)
    .filter((command) => {
      if (commandPlacement(command).scope !== scope || !isAvailable(source, command)) return false;
      return scope !== "app" || commandOnActiveSurface(command, source.ctx);
    })
    .map((command) => ({ command, section: sectionOf(source, command) }))
    .sort(
      (a, b) =>
        rank(a.section) - rank(b.section) ||
        compareText(a.section, b.section) ||
        (a.command.order ?? UNORDERED) - (b.command.order ?? UNORDERED) ||
        compareText(a.command.title, b.command.title) ||
        compareText(a.command.id, b.command.id),
    )
    .map(({ command }) => commandRow(source, command, { sectioned: true }));
}

function recentRows(source: DeckSource): DeckRow[] {
  const byId = new Map(uniqueCommands(source).map((command) => [command.id, command]));
  const rows: DeckRow[] = [];
  for (const id of source.recent) {
    const command = byId.get(id);
    if (!command || !isAvailable(source, command)) continue;
    const row = commandRow(source, command);
    rows.push({ ...row, id: `recent:${command.id}`, section: RECENT_SECTION });
    if (rows.length === RECENT_LIMIT) break;
  }
  return rows;
}

// ---- settings ----------------------------------------------------------

function sectionLabel(source: DeckSource, id: string): string {
  return source.sections.find((section) => section.id === id)?.label ?? id;
}

function availableSettings(source: DeckSource, section?: string): SettingSpec[] {
  return source.settings.filter(
    (spec) => (section === undefined || spec.section === section) && spec.available(),
  );
}

function settingBreadcrumb(source: DeckSource, spec: SettingSpec): string {
  return `${SETTINGS_LABEL}${SEPARATOR}${sectionLabel(source, spec.section)}`;
}

function settingSearchText(source: DeckSource, spec: SettingSpec): string {
  return [
    spec.label,
    ...(spec.keywords ?? []),
    sectionLabel(source, spec.section),
    SETTINGS_LABEL,
  ].join(" ");
}

/// A field's row. `path` is the branch the row is listed in, so a choice
/// opened from inside a section returns to it.
function settingRow(
  source: DeckSource,
  spec: SettingSpec,
  open: (section: string, field?: string) => void,
  options: { sectioned?: boolean; path?: readonly string[] } = {},
): DeckRow {
  const row: DeckRow = {
    id: `setting:${spec.id}`,
    title: spec.label,
    breadcrumb: settingBreadcrumb(source, spec),
    searchText: settingSearchText(source, spec),
    scope: "settings",
  };
  if (options.sectioned) row.section = sectionLabel(source, spec.section);
  const current = spec.read();
  const write = spec.write;
  if (spec.kind === "toggle" && write) {
    row.kind = "toggle";
    // A change still under way reads in place of the value.
    const progress = spec.progress?.() ?? null;
    row.value = progress ?? stateValue(typeof current === "boolean" ? current : null);
    // A value that has not loaded cannot be flipped, nor one that is changing.
    if (typeof current === "boolean" && progress === null) {
      // The row writes the opposite of the value it shows. A write that
      // raises a question puts it on the card each time it is chosen, and
      // the answer runs the write the question carries.
      const question = spec.confirm?.(!current) ?? null;
      if (question) row.confirm = () => question;
      row.after = "stay";
      row.run = question ? question.write : () => write(!current);
    } else {
      row.disabled = true;
    }
    return row;
  }
  if (spec.kind === "choice" && write && spec.options?.length) {
    row.kind = "choice";
    row.value =
      spec.options.find((option) => option.value === current)?.label ??
      (typeof current === "string" ? current : undefined);
    row.next = [...(options.path ?? []), settingLevel(spec.id)];
    return row;
  }
  // Every other field is edited in the overlay, which lands on it.
  row.kind = "action";
  if (typeof current === "string" && current !== "") row.value = current;
  row.after = "close";
  row.run = () => open(spec.section, spec.id);
  return row;
}

function settingOptionRows(source: DeckSource, spec: SettingSpec, leaf: boolean): DeckRow[] {
  const write = spec.write;
  if (spec.kind !== "choice" || !write) return [];
  const current = spec.read();
  const breadcrumb = settingBreadcrumb(source, spec);
  return (spec.options ?? []).map((option) => ({
    id: `setting:${spec.id}=${option.value}`,
    title: leaf ? `${spec.label}: ${option.label}` : option.label,
    breadcrumb: leaf ? breadcrumb : `${breadcrumb}${SEPARATOR}${spec.label}`,
    searchText: `${settingSearchText(source, spec)} ${option.label}`,
    scope: "settings",
    checked: option.value === current,
    kind: "action" as const,
    after: "stay" as const,
    run: () => write(option.value),
  }));
}

/// The Settings section the focused app's preferences live in, when it has
/// one with a field this window shows.
function appSettingsSection(source: DeckSource): DeckSettingsSection | null {
  const surface = source.ctx.activeSurface;
  const category = surface ? SURFACE_CATEGORIES[surface] : undefined;
  if (!category) return null;
  const section = source.sections.find((candidate) => candidate.category === category);
  return section && availableSettings(source, section.id).length > 0 ? section : null;
}

/// What the unscoped list shows of Settings: the row that opens the overlay
/// and a branch into the focused app's section.
function settingsSummaryRows(source: DeckSource): DeckRow[] {
  const rows = scopeRows(source, "settings");
  const section = appSettingsSection(source);
  if (section && source.app) {
    const title = `${source.app.label} settings`;
    rows.push({
      id: `settings:section:${section.id}`,
      title,
      breadcrumb: SETTINGS_LABEL,
      searchText: `${title} ${section.label} preferences`,
      scope: "settings",
      section: SETTINGS_LABEL,
      kind: "branch",
      next: [sectionLevel(section.id)],
    });
  }
  return rows;
}

/// The whole Settings scope: each rail section's fields under its name, then
/// the row that opens the overlay where it was last left.
function settingsScopeRows(
  source: DeckSource,
  open: (section: string, field?: string) => void,
): DeckRow[] {
  const rows = source.sections.flatMap((section) =>
    availableSettings(source, section.id).map((spec) =>
      settingRow(source, spec, open, { sectioned: true }),
    ),
  );
  rows.push(...scopeRows(source, "settings"));
  return rows;
}

// ---- typed order -------------------------------------------------------
//
// A typed query ranks rows by the kind of hit first: a title that is the
// whole query, a word that starts a title word, one inside a title word, one
// that starts a word elsewhere, one inside a word elsewhere, a title
// abbreviation. Among hits of one kind the position and the title's length
// decide, which says little about which of two scopes was meant: another
// window's `Close Window 2` is no better a hit for `close` than `Close tab`.
// So hits of one kind, which the ranking reports with each match, are listed
// in scope order, nearest the focus first, and the ranking decides inside a
// scope. The whole-title kind is the ranking's own, so a row titled exactly
// as typed leads whatever its scope, here and on the Computers page.

/// Where a row's scope stands among hits of one kind: the focused app's rows,
/// the pane's, the window's, the workspace's, a command of an app that is not
/// focused, the settings, then this machine's objects.
function scopeOrder(source: DeckSource, row: DeckRow): number {
  switch (row.scope) {
    case "app":
      return row.command && commandOnActiveSurface(row.command, source.ctx) ? 0 : 4;
    case "pane":
      return 1;
    case "window":
      return 2;
    case "workspace":
      return 3;
    case "settings":
      return 5;
    default:
      return 6;
  }
}

/// Ranked matches with the hits of one kind put in scope order. Rows that
/// cannot run stay last, and the sort is stable, so inside one scope the
/// ranking's own order stands.
function inScopeOrder(source: DeckSource, ranked: readonly DeckMatch<DeckRow>[]): DeckRow[] {
  return ranked
    .map(({ item, kind }) => ({
      row: item,
      disabled: Number(item.disabled === true),
      kind,
      scope: scopeOrder(source, item),
    }))
    .sort((a, b) => a.disabled - b.disabled || b.kind - a.kind || a.scope - b.scope)
    .map((placed) => placed.row);
}

// ---- lists -------------------------------------------------------------

/// Opens the Settings overlay on a section and, inside it, a field.
export type OpenSettings = (section: string, field?: string) => void;

/// The list an empty query shows. With no scope: the recent commands, the
/// focused app's, the pane's three groups, the window's, the workspace's and
/// the Settings summary, each under its heading. With a scope: that scope's
/// sections alone. The Computers rows are the launcher component's.
export function browseRows(
  source: DeckSource,
  scope: string | null,
  open: OpenSettings,
): DeckRow[] {
  switch (scope) {
    case null:
      return [
        ...recentRows(source),
        ...scopeRows(source, "app"),
        ...scopeRows(source, "pane"),
        ...scopeRows(source, "window"),
        ...scopeRows(source, "workspace"),
        ...settingsSummaryRows(source),
      ];
    case "app":
    case "pane":
    case "window":
    case "workspace":
      return scopeRows(source, scope);
    case "settings":
      return settingsScopeRows(source, open);
    default:
      return [];
  }
}

/// The list a typed query shows: flat and ranked, over every scope or the
/// active one, with hits of one kind in scope order. A choice lists its
/// options as leaves beside itself, so one step applies a value. A setting
/// that a command also changes is left to the command. Commands that cannot
/// run here follow the ones that can, a few at most, each with its reason.
/// `extra` rows are ranked with the rest.
export function searchRows(
  source: DeckSource,
  scope: string | null,
  query: string,
  open: OpenSettings,
  extra: readonly DeckRow[] = [],
): DeckRow[] {
  const raw = query.trim();
  const inScope = (candidate: DeckScopeName): boolean => scope === null || scope === candidate;
  const enabled: DeckRow[] = [...extra];
  const unavailable: DeckRow[] = [];
  const listed = new Set<string>();
  // `Open notes/x.md` scores `Open` against an acceptsArg command and keeps
  // the remainder verbatim for the run.
  const split = /^(\S+)\s+(.+)$/.exec(raw);

  for (const command of uniqueCommands(source)) {
    const { scope: home } = commandPlacement(command);
    if (!inScope(home)) continue;
    // The App scope is the focused app's alone.
    if (scope === "app" && !commandOnActiveSurface(command, source.ctx)) continue;
    if (!isAvailable(source, command)) {
      const reason = commandUnavailableReason(command, source.ctx);
      if (reason !== null) unavailable.push(commandRow(source, command, { unavailable: reason }));
      continue;
    }
    listed.add(command.id);
    enabled.push(commandRow(source, command));
    if (command.kind === "choice") {
      for (const option of command.options?.(source.ctx) ?? []) {
        enabled.push(optionRow(source, command, option, true));
      }
    }
    if (
      split &&
      command.acceptsArg &&
      fuzzyDeckScore(split[1], `${command.title} ${(command.keywords ?? []).join(" ")}`) !== null
    ) {
      enabled.push(commandRow(source, command, { arg: split[2] }));
    }
  }

  if (inScope("settings")) {
    for (const spec of availableSettings(source)) {
      if (spec.command !== undefined && listed.has(spec.command)) continue;
      enabled.push(settingRow(source, spec, open));
      enabled.push(...settingOptionRows(source, spec, true));
    }
  }

  return [
    ...inScopeOrder(source, matchDeckItems(enabled, raw)),
    ...rankDeckItems(unavailable, raw).slice(0, UNAVAILABLE_LIMIT),
  ];
}

/// The rows of a branch the builders own: a choice command's options, a
/// choice setting's options, or one Settings section's fields. Null when the
/// path's innermost level is not theirs, or names something this window no
/// longer offers.
export function branchRows(
  source: DeckSource,
  path: readonly string[],
  open: OpenSettings,
): DeckRow[] | null {
  const level = path.at(-1);
  if (level === undefined) return null;
  if (level.startsWith(CHOICE_LEVEL)) {
    const id = level.slice(CHOICE_LEVEL.length);
    const command = uniqueCommands(source).find((candidate) => candidate.id === id);
    if (!command || command.kind !== "choice" || !isAvailable(source, command)) return null;
    return (command.options?.(source.ctx) ?? []).map((option) =>
      optionRow(source, command, option, false),
    );
  }
  if (level.startsWith(SETTING_LEVEL)) {
    const id = level.slice(SETTING_LEVEL.length);
    const spec = availableSettings(source).find((candidate) => candidate.id === id);
    if (!spec || spec.kind !== "choice" || !spec.write) return null;
    return settingOptionRows(source, spec, false);
  }
  if (level.startsWith(SECTION_LEVEL)) {
    const id = level.slice(SECTION_LEVEL.length);
    const specs = availableSettings(source, id);
    if (specs.length === 0) return null;
    return specs.map((spec) => settingRow(source, spec, open, { path }));
  }
  return null;
}

/// Where the launcher stands, outermost first: the active scope, or the
/// scope a branch belongs to and then the branch. Undefined at the root with
/// no scope, and for a branch the builders do not own.
export function deckCrumbs(
  source: DeckSource,
  scope: string | null,
  path: readonly string[],
): string[] | undefined {
  const level = path.at(-1);
  if (level === undefined) return isScopeName(scope) ? [scopeLabel(source, scope)] : undefined;
  if (level.startsWith(CHOICE_LEVEL)) {
    const id = level.slice(CHOICE_LEVEL.length);
    const command = uniqueCommands(source).find((candidate) => candidate.id === id);
    if (!command) return undefined;
    const home = commandPlacement(command).scope;
    return [home === "app" ? sectionOf(source, command) : SCOPE_LABELS[home], command.title];
  }
  if (level.startsWith(SETTING_LEVEL)) {
    const id = level.slice(SETTING_LEVEL.length);
    const spec = source.settings.find((candidate) => candidate.id === id);
    if (!spec) return undefined;
    return [SETTINGS_LABEL, sectionLabel(source, spec.section), spec.label];
  }
  if (level.startsWith(SECTION_LEVEL)) {
    return [SETTINGS_LABEL, sectionLabel(source, level.slice(SECTION_LEVEL.length))];
  }
  return undefined;
}
