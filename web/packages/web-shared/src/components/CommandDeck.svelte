<script module lang="ts">
  let pendingReturnFocus: HTMLElement | null = null;

  /// The element a run in flight will hand focus back to, from the run's
  /// start until the deck's close has rendered, or until the run has settled
  /// while the deck stayed open. A dialog a command opens as it runs mounts
  /// in the flush that unmounts the deck's input, while that input still
  /// holds focus or just after it left, and the deck is gone by the time the
  /// dialog closes; the dialog takes this as the element to return focus to.
  /// A dialog opened later, from another control during a long run, is not
  /// the command's and takes its own opener.
  export function deckPendingReturnFocus(): HTMLElement | null {
    return pendingReturnFocus;
  }
</script>

<script lang="ts">
  import PrivateField from "./PrivateField.svelte";
  import { tick } from "svelte";
  import { canTakeFocus } from "../modalFocus";
  import type {
    DeckConfirm,
    DeckDraft,
    DeckIcon,
    DeckItem,
    DeckScope,
    DeckScopeId,
  } from "../command-deck/model";

  const SEARCH_PLACEHOLDER = "Search";

  let {
    open,
    draft = $bindable(),
    items,
    scopes,
    placeholder = SEARCH_PLACEHOLDER,
    bodyKey = "root",
    direction = "forward",
    onClose,
    onChoose,
    onBack,
    onScope,
    onClearScope,
    onExpand,
    crumbs,
    onSuccess,
    onError,
    onFocusLost,
    mayTakeFocus,
  }: {
    open: boolean;
    draft: DeckDraft;
    items: DeckItem[];
    scopes: DeckScope[];
    placeholder?: string;
    bodyKey?: string;
    direction?: "forward" | "back" | "still";
    onClose: () => void;
    onChoose: (item: DeckItem) => void | DeckConfirm | Promise<void | DeckConfirm>;
    onBack: () => void;
    onScope: (scope: DeckScopeId) => void;
    onClearScope: () => void;
    /// Open the page of an `expandable` row, the one Enter would run.
    onExpand?: (item: DeckItem) => void;
    /// Where the deck stands, outermost first: the scope, then each branch
    /// entered. Drawn beside the query; absent means the active scope alone.
    crumbs?: string[];
    onSuccess?: (item: DeckItem) => void;
    onError: (item: DeckItem, error: unknown) => void;
    /// A run closed the deck and left focus nowhere, and the element the
    /// deck opened from can no longer take it. A host that owns an active
    /// surface of its own puts the keyboard there.
    onFocusLost?: () => void;
    /// Whether the page may move focus at all right now. A host whose
    /// keyboard is held outside the page, such as a native launcher window
    /// shown over it, answers false, and the deck then hands focus to
    /// nothing: a focus change in the page would take the keyboard from
    /// that surface.
    mayTakeFocus?: () => boolean;
  } = $props();

  const LIST_ID = "chan-command-deck-list";
  const optionId = (index: number): string => `chan-command-deck-option-${index}`;
  const sectionId = (index: number): string => `chan-command-deck-section-${index}`;
  /// The rows a page moves by where the list has no layout to measure.
  const FALLBACK_PAGE_ROWS = 10;
  /// The widest value the right column makes room for, in character cells.
  /// A longer one is cut short with an ellipsis.
  const VALUE_SLOT_CELLS = 24;
  /// Keys that only arm another key. Holding one is not a key press of its
  /// own: Shift goes down before the `?` it types.
  const LONE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
  /// The deck's keys, as the key list shows them.
  const KEY_LIST: readonly { keys: readonly string[]; does: string }[] = [
    { keys: ["↑", "↓"], does: "Previous, next row" },
    { keys: ["PageUp", "PageDown"], does: "One page up, down" },
    { keys: ["Home", "End"], does: "First, last row, on an empty query" },
    { keys: ["Alt+↑", "Alt+↓"], does: "Previous, next section" },
    { keys: ["Tab", "Shift+Tab"], does: "Next, previous scope" },
    { keys: ["Enter"], does: "Run the row, or open it" },
    { keys: ["→"], does: "Open a row that holds more, from the end of the query" },
    { keys: ["←", "Backspace"], does: "Back one level, on an empty query" },
    { keys: ["Esc"], does: "Back one level, then close" },
    { keys: ["?"], does: "This list, on an empty query" },
  ];

  /// A run of consecutive rows under one heading. `title` is null for rows
  /// that carry no section; those render flat, with no header.
  interface DeckSection {
    title: string | null;
    start: number;
    rows: DeckItem[];
  }

  // Focus stays on the input for as long as the deck is open. Rows and orbs
  // are never tab stops; the selected row is a virtual one the input names
  // through aria-activedescendant.
  let input: HTMLInputElement | undefined = $state();
  let overlay: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let keyList: HTMLElement | undefined = $state();
  let keyboardIndex = $state(0);
  let pointerIndex: number | null = $state(null);
  let keysShown = $state(false);
  // Where the pointer last reported itself, to tell a pointer that moved
  // from one the list moved under.
  let lastPointer: { x: number; y: number } | null = null;
  let listedIds = "";
  let wasOpen = false;
  let closeVersion = 0;
  // The element that held focus as the deck opened, where focus goes back to
  // when the deck closes and nothing under it asked for the keyboard since.
  let returnFocus: HTMLElement | null = null;
  // The element under the deck that last took the keyboard while the deck was
  // open, and lost it to the query at once. A row that changes something in
  // place can show a surface that focuses itself: a composer, an editor
  // remounted by a mode switch, a terminal handed the keyboard back. The
  // request is kept, not refused: when the deck closes the keyboard goes
  // there, where it would be had the deck not been open.
  let deferredFocus: HTMLElement | null = null;
  // The run in flight: a plain item while the host handles it, an awaited
  // one while the host takes its success. A close while a run is in flight
  // leaves focus where it is, whatever closed the deck, since the command may
  // be putting it on a surface of its own; once the run settles,
  // settleRunFocus hands back focus the command left nowhere. Any other
  // close (Escape, the backdrop, the host hiding the deck) hands focus back
  // at once.
  let closingRun: object | null = null;
  let confirmKeyReleased = true;
  // Tokens bind card writes to the preparation or command currently owning it.
  let preparationToken: object | null = null;
  let executionToken: object | null = null;

  const activeIndex = $derived(pointerIndex ?? keyboardIndex);
  const availableScopes = $derived(scopes.filter((scope) => scope.available !== false));
  const selectedItem = $derived(items[activeIndex]);
  const activeScope = $derived(
    draft.scope ? scopes.find((scope) => scope.id === draft.scope) : undefined,
  );
  const trail = $derived(crumbs?.length ? crumbs : activeScope ? [activeScope.label] : []);
  // A host names the scope or the branch in its placeholder, which the chip
  // already says; beside the chip the field reads as a plain search.
  const shownPlaceholder = $derived(trail.length ? SEARCH_PLACEHOLDER : placeholder);
  const sections = $derived.by<DeckSection[]>(() => {
    const runs: DeckSection[] = [];
    items.forEach((item, index) => {
      const title = item.section || null;
      const last = runs[runs.length - 1];
      if (last && last.title === title) last.rows.push(item);
      else runs.push({ title, start: index, rows: [item] });
    });
    return runs;
  });
  const sectioned = $derived(sections.some((section) => section.title !== null));
  // What the rows hold in their right column. Every row reserves the same
  // slots, each as wide as the list's longest entry, so values, shortcuts
  // and chevrons line up down the list whichever rows carry them. A slot no
  // row fills is left out.
  const columns = $derived.by(() => {
    let value = 0;
    let shortcut = 0;
    let check = false;
    let chevron = false;
    for (const item of items) {
      if (item.value) value = Math.max(value, textCells(item.value));
      if (item.shortcut) shortcut = Math.max(shortcut, textCells(item.shortcut));
      if (item.checked) check = true;
      if (opens(item)) chevron = true;
    }
    return { value: Math.min(value, VALUE_SLOT_CELLS), shortcut, check, chevron };
  });
  const listShown = $derived(!draft.operation && !keysShown);
  const hints = $derived.by<{ keys: string[]; does: string }[]>(() => {
    const operation = draft.operation;
    if (operation?.kind === "confirm") {
      return [
        { keys: ["←", "→"], does: "choose" },
        { keys: ["Enter"], does: "select" },
        { keys: ["Esc"], does: "cancel" },
      ];
    }
    if (operation?.kind === "error") {
      return [
        { keys: ["←", "→"], does: "choose" },
        { keys: ["Enter"], does: "select" },
        { keys: ["Esc"], does: "back" },
      ];
    }
    if (operation?.kind === "preparing" || operation?.kind === "pending") {
      return [{ keys: ["Esc"], does: "dismiss" }];
    }
    if (operation) return [];
    if (keysShown) return [{ keys: ["Esc"], does: "back to the list" }];
    return [
      { keys: ["↑", "↓"], does: "move" },
      { keys: ["Enter"], does: "run" },
      { keys: ["→"], does: "open" },
      ...(availableScopes.length ? [{ keys: ["Tab"], does: "scope" }] : []),
      { keys: ["Esc"], does: draft.path.length ? "back" : "close" },
    ];
  });

  /// The icon a section's header carries: its scope's, when every row under
  /// it belongs to one scope the rail shows.
  function sectionIcon(section: DeckSection): DeckIcon | undefined {
    const scope = section.rows[0]?.scope;
    if (section.rows.some((row) => row.scope !== scope)) return undefined;
    return scopes.find((candidate) => candidate.id === scope)?.icon;
  }

  /// The width of a text in character cells: the unit the right column's
  /// slots are sized in. An East Asian wide character takes two.
  function textCells(text: string): number {
    let cells = 0;
    for (const character of text) cells += (character.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    return cells;
  }

  /// Whether the row leads to a list of its own.
  function opens(item: DeckItem): boolean {
    return item.kind === "branch" || item.kind === "choice" || item.expandable === true;
  }

  function focusInput(): void {
    if (document.activeElement !== input) input?.focus({ preventScroll: true });
  }

  /// Bring the selected row into the list's view. Layout is the engine's:
  /// where elements have no scrollIntoView there is nothing to scroll.
  function revealSelection(): void {
    void tick().then(() => {
      const row = document.getElementById(optionId(keyboardIndex));
      if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    });
  }

  function reconcileSelection(): void {
    if (!items.length) {
      keyboardIndex = -1;
      draft.selectedId = null;
      return;
    }
    const restored = draft.selectedId
      ? items.findIndex((item) => item.id === draft.selectedId)
      : -1;
    keyboardIndex = restored >= 0 ? restored : 0;
    draft.selectedId = items[keyboardIndex]?.id ?? null;
  }

  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      deferredFocus = null;
      closingRun = null;
      reconcileSelection();
      pointerIndex = null;
      lastPointer = null;
      keysShown = false;
      // The query is selected so Enter repeats it and typing replaces it.
      void tick().then(() => {
        input?.focus();
        input?.select();
      });
      // A restored selection may sit below the rows the list shows.
      revealSelection();
    } else if (!isOpen && wasOpen) {
      closeVersion += 1;
      // Preserve the viewport while restoring the caller's focus.
      const heir = canTakeFocus(deferredFocus) ? deferredFocus : returnFocus;
      if (!closingRun && heir?.isConnected) heir.focus({ preventScroll: true });
      returnFocus = null;
      // The pending opener is for a dialog that mounts in the flush that
      // unmounts this deck's input. Once that close has rendered, a dialog
      // opened from anywhere else during a long run takes its own opener.
      const pending = pendingReturnFocus;
      void tick().then(() => {
        if (pendingReturnFocus === pending) pendingReturnFocus = null;
      });
    }
    wasOpen = isOpen;
  });

  $effect(() => {
    const ids = items.map((item) => item.id).join("\u001f");
    if (!open) return;
    // A hovered row index means nothing in a different list. The same list
    // delivered again, as a host that polls does, keeps it.
    if (ids !== listedIds) {
      listedIds = ids;
      pointerIndex = null;
    }
    reconcileSelection();
  });

  function selectRow(index: number): void {
    if (!items.length) {
      keyboardIndex = -1;
      draft.selectedId = null;
      return;
    }
    keyboardIndex = Math.max(0, Math.min(items.length - 1, index));
    draft.selectedId = items[keyboardIndex]?.id ?? null;
    pointerIndex = null;
    revealSelection();
  }

  /// The selected row's index, held inside the list.
  function currentRow(): number {
    return Math.max(0, Math.min(items.length - 1, activeIndex));
  }

  function moveRow(delta: 1 | -1): void {
    if (!items.length) return;
    selectRow((currentRow() + delta + items.length) % items.length);
  }

  /// The number of rows the list shows at once, measured from the selected
  /// row's height.
  function pageRows(): number {
    const visible = list?.clientHeight ?? 0;
    const row = document.getElementById(optionId(currentRow()))?.offsetHeight ?? 0;
    return visible > 0 && row > 0 ? Math.max(1, Math.floor(visible / row)) : FALLBACK_PAGE_ROWS;
  }

  function movePage(delta: 1 | -1): void {
    if (!items.length) return;
    selectRow(currentRow() + delta * pageRows());
  }

  function moveSection(delta: 1 | -1): void {
    if (!items.length) return;
    const row = currentRow();
    let current = 0;
    sections.forEach((section, index) => {
      if (section.start <= row) current = index;
    });
    const next = sections[(current + delta + sections.length) % sections.length];
    if (next) selectRow(next.start);
  }

  function applyScope(scope: DeckScope | null): void {
    keysShown = false;
    if (scope) {
      draft.scope = scope.id;
      onScope(scope.id);
    } else {
      draft.scope = null;
      onClearScope();
    }
  }

  /// Step through the scopes the host offers now. "No scope" is one stop of
  /// the cycle, between the last scope and the first.
  function cycleScope(delta: 1 | -1): void {
    if (!availableScopes.length) return;
    const stops = availableScopes.length + 1;
    const at = availableScopes.findIndex((scope) => scope.id === draft.scope) + 1;
    const next = (at + delta + stops) % stops;
    applyScope(next === 0 ? null : availableScopes[next - 1] ?? null);
  }

  function pressScope(scope: DeckScope): void {
    if (scope.available === false) return;
    focusInput();
    applyScope(draft.scope === scope.id ? null : scope);
  }

  function pressRow(item: DeckItem, index: number): void {
    keyboardIndex = index;
    pointerIndex = index;
    draft.selectedId = item.id;
    // Before the run, so a command that puts focus somewhere keeps it.
    focusInput();
    choose(item);
  }

  /// A press inside the deck leaves focus on the input: the default action
  /// of a press on a row or an orb would move it there. A press on a
  /// scrolling box itself is its scrollbar's, and cancelling it would stop
  /// the drag; the list hands the focus it takes straight back.
  function holdInputFocus(event: MouseEvent): void {
    if (event.target === input || event.target === list || event.target === keyList) return;
    event.preventDefault();
    focusInput();
  }

  /// Engines that re-run hit testing after a scroll report a move from a
  /// pointer at rest, at the position it last had. Only a report from a new
  /// position selects, so the row the keyboard chose is not taken back by the
  /// list scrolling under the pointer.
  function pointerOverRow(event: PointerEvent, index: number): void {
    const moved =
      lastPointer !== null && (lastPointer.x !== event.screenX || lastPointer.y !== event.screenY);
    lastPointer = { x: event.screenX, y: event.screenY };
    if (moved) pointerIndex = index;
  }

  async function openConfirm(item: DeckItem, enterHeld = false): Promise<void> {
    const request = item.confirm;
    if (!request) return;
    confirmKeyReleased = !enterHeld;
    const executionDraft = draft;
    const token = {};
    preparationToken = token;
    executionToken = null;
    let confirmation: DeckConfirm;
    if (typeof request === "function") {
      executionDraft.operation = { kind: "preparing", itemId: item.id, title: item.title };
      const stillPreparing = (): boolean =>
        preparationToken === token &&
        draft === executionDraft &&
        executionDraft.operation?.kind === "preparing" &&
        executionDraft.operation.itemId === item.id;
      try {
        confirmation = await request();
      } catch (error) {
        if (!stillPreparing()) return;
        preparationToken = null;
        executionDraft.operation = {
          kind: "error",
          itemId: item.id,
          title: item.title,
          message: errorMessage(error),
          selected: "back",
        };
        return;
      }
      if (!stillPreparing()) return;
    } else {
      confirmation = request;
    }
    if (preparationToken === token) preparationToken = null;
    executionDraft.operation = {
      kind: "confirm",
      itemId: item.id,
      title: confirmation.title,
      message: confirmation.message,
      actionLabel: confirmation.actionLabel,
      danger: confirmation.danger === true,
      selected: "cancel",
    };
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function succeed(item: DeckItem): void {
    const run = {};
    closingRun = run;
    try {
      onSuccess?.(item);
    } finally {
      // Still open: the host kept the deck up, or its handler threw and the
      // error card is showing, so the next close is a dismissal.
      if (open && closingRun === run) closingRun = null;
    }
  }

  /// Whether `element` holds the keyboard: a connected element other than
  /// the page itself. The connection check is defensive: an element removed
  /// from the page, such as this deck's input after a close, has given focus
  /// up whatever the engine still reports.
  function holdsFocus(element: Element | null): boolean {
    return element instanceof Element && element.isConnected &&
      element !== document.body && element !== document.documentElement;
  }

  /// A run that closes the deck decides where the keyboard goes, so that
  /// close hands focus to nothing. A command that moves focus nowhere would
  /// leave it on the body, where the terminal or editor under the deck gets
  /// no keys until it is clicked. Once the run has settled and the close has
  /// rendered, focus still at large goes to the surface that asked for it
  /// under the open deck, when it can take it, else back to the element the
  /// deck opened from, and otherwise to the host, unless the host says the
  /// page may not take focus now. A surface the command opened after the
  /// close keeps the focus it took, and one that takes focus later takes it
  /// from the restored element as it would from any other.
  async function settleRunFocus(opener: HTMLElement | null, published: HTMLElement | null): Promise<void> {
    await tick();
    if (pendingReturnFocus === published) pendingReturnFocus = null;
    if (open || holdsFocus(document.activeElement)) return;
    if (mayTakeFocus && !mayTakeFocus()) return;
    if (canTakeFocus(deferredFocus)) deferredFocus.focus({ preventScroll: true });
    else if (canTakeFocus(opener)) opener.focus({ preventScroll: true });
    else onFocusLost?.();
  }

  async function execute(item: DeckItem): Promise<void> {
    if (item.disabled) return;
    // Captured before the run: the close effect forgets the opener as the
    // deck closes, which the run may do at once.
    const opener = returnFocus;
    const published = canTakeFocus(deferredFocus) ? deferredFocus : opener;
    pendingReturnFocus = published;
    try {
      await runItem(item);
    } finally {
      if (open) {
        if (pendingReturnFocus === published) pendingReturnFocus = null;
      } else {
        void settleRunFocus(opener, published);
      }
    }
  }

  async function runItem(item: DeckItem): Promise<void> {
    const executionDraft = draft;
    const token = {};
    executionToken = token;
    preparationToken = null;
    const executionCloseVersion = closeVersion;
    let closedDuringChoose = false;
    let pendingOperation: DeckDraft["operation"] = null;
    const ownsPending = (): boolean =>
      pendingOperation !== null &&
      executionDraft.operation === pendingOperation &&
      executionDraft.operation?.kind === "pending" &&
      executionDraft.operation.itemId === item.id;
    // Where a run may still answer: the deck as it was opened when the run
    // started, on the draft that started it, while no later run, question or
    // release has taken its token. A close is the user leaving the command,
    // so a run that saw one answers nothing in a deck opened after it: it
    // paints no card there and does not close it.
    const holdsDeck = (): boolean =>
      open && draft === executionDraft && executionToken === token &&
      closeVersion === executionCloseVersion && !closedDuringChoose;

    function reject(error: unknown): void {
      if (holdsDeck() && (!item.awaitResult || ownsPending())) {
        executionDraft.operation = {
          kind: "error",
          itemId: item.id,
          title: item.title,
          message: errorMessage(error),
          selected: "back",
        };
        return;
      }
      // Retire this run's spinner even on a hidden or replaced draft, while
      // preserving any card a later command or preparation has taken.
      if (ownsPending()) executionDraft.operation = null;
      onError(item, error);
    }

    if (!item.awaitResult) {
      const run = {};
      closingRun = run;
      try {
        const chosen = onChoose(item);
        // A host can close synchronously and reopen before the open effect
        // runs. Observe that close before yielding to the command's promise.
        closedDuringChoose = !open;
        await chosen;
      } catch (error) {
        reject(error);
      } finally {
        // Still open: the host kept the deck up (a submenu, a refusal), so
        // the next close is a dismissal.
        if (open && closingRun === run) closingRun = null;
      }
      return;
    }
    draft.operation = { kind: "pending", itemId: item.id, title: item.title };
    pendingOperation = executionDraft.operation;
    try {
      const chosen = onChoose(item);
      closedDuringChoose = !open;
      const result = await chosen;
      if (result) {
        // A follow-up confirmation is an answer like any other: only a run
        // that still holds the deck can put it.
        if (!holdsDeck()) {
          if (ownsPending()) executionDraft.operation = null;
          return;
        }
        executionDraft.operation = {
          kind: "confirm",
          itemId: item.id,
          title: result.title,
          message: result.message,
          actionLabel: result.actionLabel,
          danger: result.danger === true,
          selected: "cancel",
        };
        return;
      }
      // A success shows only while the run holds the deck. It asks for the
      // token and not the card: a host clears the card itself when the
      // command's own effect changes what the deck lists, and that is not the
      // user leaving the command, where a close is. A run that lost the deck
      // retires its own spinner, on a hidden or replaced draft too, and
      // leaves the rest.
      if (!holdsDeck()) {
        if (ownsPending()) executionDraft.operation = null;
        return;
      }
      if (item.dismissImmediatelyOnSuccess) {
        succeed(item);
        return;
      }
      executionDraft.operation = { kind: "success", itemId: item.id, title: item.title };
      const successOperation = executionDraft.operation;
      await new Promise((resolve) => setTimeout(resolve, 260));
      // The deck can be hidden or its draft replaced while the card shows,
      // and the host's handler closes the deck, so the hold is read again
      // before it runs.
      if (holdsDeck()) {
        succeed(item);
      } else if (executionDraft.operation === successOperation) {
        executionDraft.operation = null;
      }
    } catch (error) {
      reject(error);
    }
  }

  function choose(item: DeckItem | undefined, enterHeld = false): void {
    if (!item || item.disabled) return;
    if (item.confirm && draft.operation?.itemId !== item.id) {
      void openConfirm(item, enterHeld);
      return;
    }
    void execute(item);
  }

  function operationItem(): DeckItem | undefined {
    const id = draft.operation?.itemId;
    return id ? items.find((item) => item.id === id) : undefined;
  }

  function operationBack(): void {
    releaseOperation();
    void tick().then(() => input?.focus());
  }

  function retry(item: DeckItem, enterHeld = false): void {
    if (typeof item.confirm === "function") void openConfirm(item, enterHeld);
    else void execute(item);
  }

  /// Return to the results list and release ownership of the operation card.
  /// An in-flight command settles independently.
  function releaseOperation(): void {
    preparationToken = null;
    executionToken = null;
    draft.operation = null;
  }

  function operationEnter(event: KeyboardEvent): void {
    const operation = draft.operation;
    if (!operation || event.repeat || !confirmKeyReleased) return;
    if (operation.kind === "confirm") {
      if (operation.selected === "cancel") {
        operationBack();
        return;
      }
      const item = operationItem();
      if (item) void execute(item);
    } else if (operation.kind === "error") {
      if (operation.selected === "back") {
        operationBack();
        return;
      }
      const item = operationItem();
      if (item) retry(item, true);
    }
  }

  function onInput(event: Event): void {
    draft.query = (event.currentTarget as HTMLInputElement).value;
    draft.selectedId = null;
    keyboardIndex = items.length ? 0 : -1;
    pointerIndex = null;
    keysShown = false;
    void tick().then(() => {
      if (list) list.scrollTop = 0;
    });
  }

  /// Whether the text caret sits after the last character with nothing
  /// selected, where Right has no text left to move over.
  function caretAtEnd(): boolean {
    if (!input) return true;
    const end = input.value.length;
    return input.selectionStart === end && input.selectionEnd === end;
  }

  /// Whether a modal dialog is showing. This deck is not modal and yields
  /// the keyboard to one.
  function modalShowing(): boolean {
    const modals = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], dialog[open]');
    for (const modal of modals) {
      let visible = true;
      for (let node: HTMLElement | null = modal; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.inert || style.display === "none" || style.visibility === "hidden") {
          visible = false;
          break;
        }
      }
      if (visible) return true;
    }
    return false;
  }

  /// Take the keyboard back from `element`, which is under the open deck, and
  /// remember that it asked. False when the page may not move focus now.
  function reclaimFocus(element: EventTarget | null): boolean {
    if (mayTakeFocus && !mayTakeFocus()) return false;
    if (element instanceof HTMLElement) deferredFocus = element;
    focusInput();
    return true;
  }

  /// The deck holds the keyboard while it is open and no modal dialog is
  /// showing. Enforced here, on every focus change in the page, so it holds
  /// for whatever a row or the page does under the deck, at once or later.
  function onPageFocusIn(event: FocusEvent): void {
    if (!open || !overlay) return;
    const target = event.target;
    if (!(target instanceof Node) || overlay.contains(target)) return;
    if (modalShowing()) return;
    reclaimFocus(target);
  }

  function onPageKeydown(event: KeyboardEvent): void {
    if (!open || !overlay || event.defaultPrevented) return;
    // The yield covers the page's own keys too, while a modal repairs focus
    // after removing its active control.
    if (modalShowing()) return;
    const target = event.target;
    const inside = target instanceof Node && overlay.contains(target);
    const page = target === document.body || target === document.documentElement ||
      target === document || target === window;
    // A key from an element under the deck: focus reached it unseen, while a
    // dialog was showing or the page could not take focus. The key is the
    // deck's, and the keyboard comes back with it.
    if (!inside && !page && !reclaimFocus(target)) return;
    onKeydown(event);
  }

  function onKeydown(event: KeyboardEvent): void {
    // The deck owns keyboard input while open. A command can synchronously
    // activate an app-level key mode, so letting the execution key bubble
    // would immediately drive that new mode with the same event.
    event.stopPropagation();
    // A key an input method is composing with belongs to the composition,
    // and so does the one that commits it: some engines send that Enter once
    // the composition has ended, marked only by the key code 229.
    if (event.isComposing || event.keyCode === 229 || LONE_MODIFIERS.has(event.key)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      const kind = draft.operation?.kind;
      if (kind === "preparing" || kind === "pending") {
        // An executing command continues settling in the background.
        releaseOperation();
      } else if (kind === "confirm" || kind === "error") {
        operationBack();
      } else if (keysShown) {
        keysShown = false;
      } else if (draft.path.length) {
        onBack();
      } else {
        onClose();
      }
      return;
    }

    const operation = draft.operation;
    if (operation) {
      if (operation.kind === "confirm" || operation.kind === "error") {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Tab") {
          event.preventDefault();
          operation.selected =
            operation.kind === "confirm"
              ? operation.selected === "cancel" ? "action" : "cancel"
              : operation.selected === "back" ? "retry" : "back";
        } else if (event.key === "Enter") {
          event.preventDefault();
          operationEnter(event);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          operationBack();
        }
      }
      return;
    }

    const chord = event.ctrlKey || event.metaKey || event.altKey;
    // AltGr reports as Ctrl+Alt on Windows, and some layouts type `?` with it.
    const typesText = event.key.length === 1 && !event.metaKey && event.ctrlKey === event.altKey;

    if (keysShown) {
      // Any key leaves the key list and does nothing else, except a
      // character, which starts the query.
      keysShown = false;
      if (typesText && event.key !== "?") focusInput();
      else if (!event.ctrlKey && !event.metaKey) event.preventDefault();
      return;
    }

    if (event.key === "?" && typesText && draft.query === "") {
      event.preventDefault();
      keysShown = true;
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (event.altKey) moveSection(delta);
      else moveRow(delta);
      return;
    }

    if (event.key === "Tab") {
      if (chord) return;
      // Always taken, so focus cannot walk off the input.
      event.preventDefault();
      cycleScope(event.shiftKey ? -1 : 1);
      return;
    }

    // Every other chord is the browser's or the host's.
    if (chord) return;

    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      movePage(event.key === "PageDown" ? 1 : -1);
    } else if ((event.key === "Home" || event.key === "End") && draft.query === "") {
      event.preventDefault();
      selectRow(event.key === "Home" ? 0 : items.length - 1);
    } else if (event.key === "Enter") {
      if (!items.length) return;
      event.preventDefault();
      // One press runs one row: a key still held when a branch opens would
      // go on to run the first row of it.
      if (event.repeat) return;
      choose(selectedItem, true);
    } else if (event.key === "ArrowRight") {
      // Right goes deeper and never runs: on a row with nothing under it the
      // key is the caret's.
      const item = selectedItem;
      if (!item || item.disabled || event.shiftKey || !caretAtEnd()) return;
      if (item.kind === "branch" || item.kind === "choice") {
        event.preventDefault();
        choose(item);
      } else if (item.expandable && onExpand) {
        event.preventDefault();
        onExpand(item);
      }
    } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && draft.query === "") {
      event.preventDefault();
      onBack();
    } else if (typesText) {
      // Typing reaches the query even after focus fell to the page.
      focusInput();
    }
  }
</script>

<svelte:window
  onkeydowncapture={onPageKeydown}
  onfocusincapture={onPageFocusIn}
  onkeyup={(event) => { if (event.key === "Enter") confirmKeyReleased = true; }}
/>

{#snippet keycaps(keys: readonly string[])}
  {#each keys as key (key)}<kbd>{key}</kbd>{/each}
{/snippet}

{#snippet resultRow(item: DeckItem, index: number)}
  {@const Icon = item.icon}
  <button
    class="deck-result"
    class:active={index === activeIndex}
    class:disabled={item.disabled}
    class:danger={item.danger}
    id={optionId(index)}
    type="button"
    role="option"
    tabindex="-1"
    aria-selected={index === activeIndex}
    aria-disabled={item.disabled === true}
    aria-checked={item.checked ? "true" : undefined}
    disabled={item.disabled}
    onclick={() => pressRow(item, index)}
    onpointermove={(event) => pointerOverRow(event, index)}
  >
    <span class="deck-result-icon">
      {#if Icon}<Icon size={16} strokeWidth={1.6} aria-hidden="true" />{/if}
    </span>
    <span class="deck-result-copy">
      <span class="deck-result-title">{item.title}</span>
      {#if item.subtitle}
        <span class="deck-result-subtitle">{item.subtitle}</span>
      {:else if !item.section && item.breadcrumb}
        <span class="deck-result-path">{item.breadcrumb}</span>
      {/if}
    </span>
    {#if columns.value}
      <span class="deck-slot deck-slot-value">
        {#if item.value}
          <span class="deck-result-value" class:on={item.value.toLowerCase() === "on"}>{item.value}</span>
        {/if}
      </span>
    {/if}
    {#if columns.check}
      <span class="deck-slot deck-slot-check">
        {#if item.checked}
          <svg class="deck-check" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>
        {/if}
      </span>
    {/if}
    {#if columns.shortcut}
      <span class="deck-slot deck-slot-shortcut">
        {#if item.shortcut}<kbd>{item.shortcut}</kbd>{/if}
      </span>
    {/if}
    {#if columns.chevron}
      <span class="deck-slot deck-slot-chevron">
        {#if opens(item)}
          <svg class="deck-chevron" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
        {/if}
      </span>
    {/if}
  </button>
{/snippet}

{#if open}
  <div bind:this={overlay} class="deck-overlay" data-direction={direction}>
    <button class="deck-backdrop" type="button" aria-label="Hide command launcher" onclick={onClose}></button>
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role, a11y_no_noninteractive_element_interactions -->
    <section
      class="deck-shell"
      role="dialog"
      aria-modal="false"
      aria-label="Command launcher"
      onmousedown={holdInputFocus}
    >
      <div class="deck-topline">
        <div class="deck-capsule">
          <svg class="deck-search-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20 20-4-4"></path>
          </svg>
          {#if trail.length}
            <span class="deck-crumbs" title={trail.join(" \u203a ")}>
              <span class="deck-crumbs-trail">
                {#each trail as crumb, index}
                  {#if index > 0}
                    <svg class="deck-crumb-sep" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                  {/if}
                  <span class="deck-crumb">{crumb}</span>
                {/each}
              </span>
              <button
                class="deck-crumbs-clear"
                type="button"
                tabindex="-1"
                aria-label="Clear scope"
                title="Clear scope"
                onclick={() => {
                  focusInput();
                  applyScope(null);
                }}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
              </button>
            </span>
          {/if}
          <div class="deck-input-wrap">
            {#if !draft.query}
              {#key shownPlaceholder}
                <span class="deck-placeholder">{shownPlaceholder}</span>
              {/key}
            {/if}
            <input
              class="deck-input"
              bind:this={input}
              value={draft.query}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={LIST_ID}
              aria-activedescendant={listShown && activeIndex >= 0 ? optionId(activeIndex) : undefined}
              aria-autocomplete="list"
              aria-label={placeholder}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              oninput={onInput}
            />
          </div>
        </div>

        {#if scopes.length}
          <div class="deck-scopes" role="group" aria-label="Scopes">
            {#each scopes as scope (scope.id)}
              {@const Icon = scope.icon}
              <button
                class="deck-scope"
                class:active={draft.scope === scope.id}
                disabled={scope.available === false}
                type="button"
                tabindex="-1"
                aria-label={`${scope.label} scope`}
                aria-pressed={draft.scope === scope.id}
                title={scope.label}
                onclick={() => pressScope(scope)}
              >
                <span class="deck-scope-orb">
                  <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
                </span>
                <span class="deck-scope-caption">{scope.caption ?? scope.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="deck-panel">
        {#if draft.contextChanged}
          <div class="deck-context-note">Context changed</div>
        {/if}
        {#if draft.operation}
          {@const operation = draft.operation}
          <div class="deck-operation" aria-live="polite">
            {#if operation.kind === "confirm"}
              <div class="deck-operation-icon">?</div>
              <div class="deck-operation-copy">
                <strong><PrivateField field={`command:${operation.itemId}:title`} label="action details">{operation.title}</PrivateField></strong>
                <span><PrivateField field={`command:${operation.itemId}:message`} label="action message">{operation.message}</PrivateField></span>
              </div>
              <div class="deck-decisions">
                <button class:chosen={operation.selected === "cancel"} type="button" onclick={operationBack}>Cancel</button>
                <button
                  class:chosen={operation.selected === "action"}
                  class:danger={operation.danger}
                  type="button"
                  onclick={() => {
                    const item = operationItem();
                    if (item) void execute(item);
                  }}
                >{operation.actionLabel}</button>
              </div>
            {:else if operation.kind === "preparing"}
              <span class="deck-spinner" aria-hidden="true"></span>
              <div class="deck-operation-copy"><strong><PrivateField field={`command:${operation.itemId}:title`} label="action details">{operation.title}</PrivateField></strong><span>Checking...</span></div>
              <div class="deck-decisions">
                <button type="button" onclick={releaseOperation}>Dismiss</button>
              </div>
            {:else if operation.kind === "pending"}
              <span class="deck-spinner" aria-hidden="true"></span>
              <div class="deck-operation-copy"><strong><PrivateField field={`command:${operation.itemId}:title`} label="action details">{operation.title}</PrivateField></strong><span>Working…</span></div>
              <div class="deck-decisions">
                <button type="button" onclick={releaseOperation}>Dismiss</button>
              </div>
            {:else if operation.kind === "success"}
              <div class="deck-operation-icon success">✓</div>
              <div class="deck-operation-copy"><strong><PrivateField field={`command:${operation.itemId}:title`} label="action details">{operation.title}</PrivateField></strong><span>Done</span></div>
            {:else}
              <div class="deck-operation-icon error">!</div>
              <div class="deck-operation-copy"><strong><PrivateField field={`command:${operation.itemId}:title`} label="action details">{operation.title}</PrivateField></strong><span><PrivateField field={`command:${operation.itemId}:message`} label="action message">{operation.message}</PrivateField></span></div>
              <div class="deck-decisions">
                <button class:chosen={operation.selected === "back"} type="button" onclick={operationBack}>Back</button>
                <button
                  class:chosen={operation.selected === "retry"}
                  type="button"
                  onclick={() => { const item = operationItem(); if (item) retry(item); }}
                >Retry</button>
              </div>
            {/if}
          </div>
        {:else if keysShown}
          <dl bind:this={keyList} class="deck-keys" aria-label="Keys" aria-live="polite">
            {#each KEY_LIST as entry (entry.does)}
              <div class="deck-keys-entry">
                <dt>{@render keycaps(entry.keys)}</dt>
                <dd>{entry.does}</dd>
              </div>
            {/each}
          </dl>
        {:else}
          {#key bodyKey}
            <div
              bind:this={list}
              class="deck-results"
              class:sectioned
              style:--deck-value-cells={columns.value}
              style:--deck-shortcut-cells={columns.shortcut}
              id={LIST_ID}
              role="listbox"
              tabindex="-1"
              aria-label="Commands"
              onfocus={focusInput}
              onpointerleave={() => (pointerIndex = null)}
            >
              {#if items.length}
                {#each sections as section, sectionIndex (section.start)}
                  {#if section.title !== null}
                    {@const HeaderIcon = sectionIcon(section)}
                    <div class="deck-section" role="group" aria-labelledby={sectionId(sectionIndex)}>
                      <div class="deck-section-header" id={sectionId(sectionIndex)} role="presentation">
                        <span class="deck-section-icon">
                          {#if HeaderIcon}<HeaderIcon size={13} strokeWidth={1.7} aria-hidden="true" />{/if}
                        </span>
                        <span class="deck-section-title">{section.title}</span>
                      </div>
                      {#each section.rows as item, offset (item.id)}
                        {@render resultRow(item, section.start + offset)}
                      {/each}
                    </div>
                  {:else}
                    {#each section.rows as item, offset (item.id)}
                      {@render resultRow(item, section.start + offset)}
                    {/each}
                  {/if}
                {/each}
              {:else}
                <p class="deck-empty">No matching commands</p>
              {/if}
            </div>
          {/key}
        {/if}
        <div class="deck-footer">
          <span class="deck-hints">
            {#each hints as hint (hint.does)}
              <span class="deck-hint">{@render keycaps(hint.keys)}<span>{hint.does}</span></span>
            {/each}
          </span>
          {#if !draft.operation}
            <button
              class="deck-hint deck-keys-toggle"
              type="button"
              tabindex="-1"
              aria-pressed={keysShown}
              onclick={() => {
                focusInput();
                keysShown = !keysShown;
              }}
            ><kbd>?</kbd><span>keys</span></button>
          {/if}
          {#if listShown}
            <span class="deck-count">{items.length} {items.length === 1 ? "item" : "items"}</span>
          {/if}
        </div>
      </div>
    </section>
  </div>
{/if}

<style>
  .deck-overlay {
    --deck-scrim: rgba(0, 0, 0, 0.56);
    /* The hosts name their accent and danger colours differently, and one
       of them names no accent, so each falls back to a token both define. */
    --deck-ring: var(--deck-accent, var(--brand, var(--text)));
    --deck-danger: var(--danger, var(--danger-text, #d1242f));
    position: fixed;
    inset: 0;
    z-index: 32000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: min(17vh, 136px) 16px 16px;
    box-sizing: border-box;
    color: var(--text);
  }
  :global([data-theme="light"]) .deck-overlay { --deck-scrim: rgba(0, 0, 0, 0.32); }
  .deck-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: var(--deck-scrim);
    cursor: default;
    animation: scrim-in 120ms ease-out;
  }
  .deck-shell {
    position: relative;
    width: min(780px, 100%);
    min-width: 0;
    outline: none;
    filter: drop-shadow(0 22px 36px rgba(0, 0, 0, 0.2));
    animation: deck-arrive 150ms ease-out;
  }
  /* One hosting page resets box-sizing and the other does not. */
  .deck-shell :global(*) { box-sizing: border-box; }
  /* The capsule asks for 300 px and takes what the rail leaves. A rail too
     wide to sit beside that much capsule wraps under it, centred. */
  .deck-topline {
    position: relative;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .deck-capsule,
  .deck-scopes,
  .deck-panel {
    background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
    -webkit-backdrop-filter: blur(22px) saturate(1.08);
    backdrop-filter: blur(22px) saturate(1.08);
  }
  .deck-capsule,
  .deck-scopes {
    min-height: 58px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16), inset 0 1px rgba(255, 255, 255, 0.08);
  }
  .deck-capsule {
    display: flex;
    align-items: center;
    flex: 1 1 300px;
    min-width: 0;
    height: 58px;
    padding: 0 16px;
    gap: 10px;
    border-radius: 999px;
  }
  .deck-search-icon,
  .deck-chevron,
  .deck-check,
  .deck-crumb-sep,
  .deck-crumbs-clear svg {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .deck-search-icon,
  .deck-chevron,
  .deck-crumb-sep { color: var(--text-secondary); }
  .deck-crumbs {
    display: inline-flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 45%;
    height: 28px;
    padding: 0 3px 0 11px;
    gap: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 9%, transparent);
    color: var(--text);
    font-size: 12.5px;
    font-weight: 500;
  }
  .deck-crumbs-trail {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 3px;
    overflow: hidden;
    white-space: nowrap;
  }
  /* A trail too long for the chip gives up its leading crumbs first, down
     to a stub each, and only then cuts the last one, which says where the
     deck stands. */
  .deck-crumb { flex: 0 100 auto; min-width: 2.5em; overflow: hidden; text-overflow: ellipsis; }
  .deck-crumb:last-child { flex-shrink: 1; }
  .deck-crumbs-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .deck-crumbs-clear:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }
  .deck-input-wrap { position: relative; flex: 1 1 80px; height: 100%; min-width: 0; }
  .deck-placeholder,
  .deck-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    font: inherit;
    font-size: 19px;
    letter-spacing: -0.012em;
  }
  .deck-placeholder {
    overflow: hidden;
    color: var(--text-secondary);
    white-space: nowrap;
    pointer-events: none;
    animation: placeholder-in 120ms ease-out;
  }
  .deck-input {
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
  }
  /* Never narrower than its cells: beside the capsule it keeps its width
     and wraps under it instead, and on a screen narrower than the rail the
     cells take a second row. */
  .deck-scopes {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    padding: 5px 7px;
    gap: 6px 2px;
    border-radius: 29px;
  }
  /* As wide as its caption. The cap is for a long label with no caption;
     it is well past ten characters. */
  .deck-scope {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    min-width: 46px;
    max-width: 104px;
    gap: 3px;
    padding: 0 6px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    cursor: pointer;
    transition: color 120ms ease, opacity 120ms ease;
  }
  .deck-scope-orb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 7%, transparent);
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .deck-scope-caption {
    max-width: 100%;
    overflow: hidden;
    font-size: 10.5px;
    line-height: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .deck-scope:hover:not(:disabled),
  .deck-scope.active { color: var(--text); }
  .deck-scope.active .deck-scope-orb {
    border-color: var(--deck-ring);
    background: color-mix(in srgb, var(--text) 16%, transparent);
  }
  .deck-scope:disabled { opacity: 0.4; cursor: default; }
  .deck-panel {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: calc(100% - 4px);
    max-height: min(480px, 66vh);
    margin: 10px 2px 0;
    overflow: hidden;
    border-radius: 20px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24), inset 0 1px rgba(255, 255, 255, 0.07);
  }
  .deck-context-note {
    flex: 0 0 auto;
    padding: 7px 16px 0;
    color: var(--text-secondary);
    font-size: 11px;
    animation: note-away 2.4s ease both;
  }
  .deck-results {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
    scroll-padding-bottom: 6px;
  }
  /* A row scrolled into view from above stops below the sticky header. */
  .deck-results.sectioned { scroll-padding-top: 28px; }
  [data-direction="forward"] .deck-results { animation: body-forward 140ms ease-out; }
  [data-direction="back"] .deck-results { animation: body-back 140ms ease-out; }
  .deck-section + .deck-section { margin-top: 4px; }
  .deck-section-header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    height: 28px;
    /* Reaches the panel's edges, so a row passing under it is covered. */
    margin: 0 -6px;
    padding: 0 16px;
    gap: 10px;
    background: var(--bg-elev);
    color: var(--text-secondary);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  /* As wide as a row's icon, so headers and titles share one left edge. */
  .deck-section-icon,
  .deck-result-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 22px;
  }
  .deck-section-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deck-result {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 36px;
    gap: 10px;
    padding: 4px 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 100ms ease;
  }
  .deck-result.active {
    background: color-mix(in srgb, var(--text) 11%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent);
  }
  .deck-result.disabled { opacity: 0.5; cursor: default; }
  .deck-result-icon { height: 22px; color: var(--text-secondary); }
  .deck-result.active .deck-result-icon { color: var(--deck-accent, var(--text)); }
  .deck-result-copy { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 1px; }
  .deck-result-title,
  .deck-result-path,
  .deck-result-subtitle,
  .deck-result-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deck-result-title { font-size: 13.5px; font-weight: 500; line-height: 18px; }
  .deck-result-path,
  .deck-result-subtitle { color: var(--text-secondary); font-size: 11.5px; line-height: 15px; }
  .deck-result.danger .deck-result-title,
  .deck-result.danger .deck-result-icon { color: var(--deck-danger); }
  /* The right column. Each slot has one width for the whole list, counted
     in the character cells of the slot's own font from the longest entry, so
     the cells of every row start at the same place. Only the title gives
     way when a row runs out of room. A value is set in a proportional face,
     where a cell is an estimate, so its slot takes one more to spare than
     the shortcut's; that one adds the chip's own padding and border. */
  .deck-slot { display: inline-flex; align-items: center; flex: 0 0 auto; min-width: 0; }
  .deck-slot-value { width: calc((var(--deck-value-cells) + 2) * 1ch); font-size: 12.5px; }
  .deck-slot-shortcut { width: calc((var(--deck-shortcut-cells) + 1) * 1ch + 14px); }
  .deck-slot-check,
  .deck-slot-chevron { justify-content: center; width: 15px; }
  .deck-result-value { min-width: 0; color: var(--text-secondary); }
  .deck-result-value.on { color: var(--accent); }
  .deck-check { color: var(--text); }
  kbd {
    flex: 0 0 auto;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
    border-radius: 6px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg) 56%, transparent);
    white-space: nowrap;
  }
  /* One font for the chip and its slot, whose width is counted in it. */
  kbd,
  .deck-slot-shortcut { font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .deck-empty { margin: 0; padding: 26px 18px; color: var(--text-secondary); text-align: center; font-size: 13px; }
  .deck-keys {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    min-height: 0;
    margin: 0;
    padding: 14px 16px;
    gap: 9px 24px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.35;
  }
  .deck-keys-entry { display: flex; align-items: baseline; min-width: 0; gap: 9px; }
  .deck-keys-entry dt { display: flex; flex: 0 0 auto; gap: 4px; }
  .deck-keys-entry dd { min-width: 0; margin: 0; color: var(--text-secondary); }
  .deck-footer {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    height: 30px;
    padding: 0 14px;
    gap: 14px;
    border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    color: var(--text-secondary);
    font-size: 11px;
    white-space: nowrap;
  }
  .deck-hints { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; gap: 14px; overflow: hidden; }
  .deck-hint { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 4px; }
  .deck-keys-toggle {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .deck-keys-toggle:hover,
  .deck-keys-toggle[aria-pressed="true"] { color: var(--text); }
  .deck-count { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .deck-operation {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 88px;
    padding: 13px 15px;
    animation: body-forward 140ms ease-out;
  }
  .deck-operation-icon,
  .deck-spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .deck-operation-icon.success { color: var(--accent); }
  .deck-operation-icon.error { color: var(--deck-danger); }
  .deck-spinner { border: 2px solid color-mix(in srgb, var(--text) 12%, transparent); border-top-color: var(--deck-ring); animation: spin 800ms linear infinite; }
  .deck-operation-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
  .deck-operation-copy strong { font-size: 14px; }
  .deck-operation-copy span { color: var(--text-secondary); font-size: 12px; line-height: 1.35; }
  .deck-decisions { display: flex; gap: 7px; }
  .deck-decisions button {
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .deck-decisions button.chosen { color: var(--text); background: color-mix(in srgb, var(--text) 7%, transparent); border-color: color-mix(in srgb, var(--text) 12%, transparent); }
  .deck-decisions button.danger.chosen { color: var(--deck-danger); }
  @keyframes scrim-in { from { opacity: 0; } }
  @keyframes deck-arrive { from { opacity: 0; transform: translateY(-6px); } }
  @keyframes placeholder-in { from { opacity: 0; transform: translateY(4px); } }
  @keyframes body-forward { from { opacity: 0; transform: translateX(10px); } }
  @keyframes body-back { from { opacity: 0; transform: translateX(-10px); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes note-away { 0%, 72% { opacity: .72; } 100% { opacity: 0; } }
  @media (max-width: 640px) {
    .deck-overlay { padding-top: 54px; }
    .deck-capsule { flex-basis: 100%; }
    .deck-panel { margin-top: 9px; }
    .deck-keys { grid-template-columns: minmax(0, 1fr); }
    /* A narrow list keeps its width for titles and values. */
    .deck-slot-shortcut { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .deck-backdrop, .deck-shell, .deck-placeholder, .deck-results, .deck-operation, .deck-spinner { animation-duration: 1ms; animation-delay: 0ms; }
    .deck-result, .deck-scope, .deck-scope-orb { transition-duration: 1ms; }
  }
</style>
