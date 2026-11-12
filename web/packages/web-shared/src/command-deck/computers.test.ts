import { describe, expect, it, vi } from "vitest";
import type { DeckConfirm } from "./model";
import {
  COMPUTERS_REASONS,
  computersConfirmBridge,
  computersDeck,
  computersFilter,
  computersScopes,
  connectionWord,
  createComputersConfirmations,
  workspaceStateWord,
  type ComputersBridge,
  type ComputersCommand,
  type ComputersContext,
  type ComputersDeck,
  type ComputersEntry,
  type ComputersGateway,
  type ComputersMachine,
  type ComputersMay,
  type ComputersModel,
  type ComputersView,
  type ComputersWindow,
  type ComputersWorkspace,
} from "./computers";

// ---- A model to build from --------------------------------------------------

function win(key: string, over: Partial<ComputersWindow> = {}): ComputersWindow {
  return { key, name: key, kind: "terminal", actions: ["focus", "hide", "close"], ...over };
}

function space(key: string, over: Partial<ComputersWorkspace> = {}): ComputersWorkspace {
  return { key, name: key, on: true, condition: "ready", windows: [], ...over };
}

function local(over: Partial<ComputersMachine> = {}): ComputersMachine {
  return { key: "local", kind: "local", name: "This machine", workspaces: [], windows: [], ...over };
}

function devserver(key: string, over: Partial<ComputersMachine> = {}): ComputersMachine {
  return {
    key,
    kind: "devserver",
    name: key,
    connection: "connected",
    editable: true,
    workspaces: [],
    windows: [],
    ...over,
  };
}

function gateway(key: string, over: Partial<ComputersGateway> = {}): ComputersGateway {
  return { key, name: key, connection: "connected", ...over };
}

/** Everything the desktop's Computers screen may do. */
const DESKTOP: ComputersMay = {
  terminal: true,
  remoteTerminal: true,
  window: true,
  terminalWindow: true,
  power: true,
  connect: true,
  tmux: true,
  newWorkspace: true,
  addDevserver: true,
  gateways: true,
  addGateway: true,
  renameGateway: true,
  showCard: true,
};

/** What a devserver's own page may do in a plain browser. */
const DEVSERVER: ComputersMay = {
  terminal: true,
  window: true,
  terminalWindow: true,
  power: true,
  tmux: true,
  newWorkspace: true,
};

function harness(): {
  ctx: ComputersContext;
  commands: ComputersCommand[];
  liveTerminals: ReturnType<typeof vi.fn>;
  turnOff: ReturnType<typeof vi.fn>;
} {
  const commands: ComputersCommand[] = [];
  const liveTerminals = vi.fn().mockResolvedValue(0);
  const turnOff = vi.fn().mockResolvedValue(null);
  const bridge = {
    run: (command: ComputersCommand) => {
      commands.push(command);
    },
    liveTerminals,
    turnOff,
  } as unknown as ComputersBridge;
  return {
    ctx: {
      bridge,
      confirmations: createComputersConfirmations(computersConfirmBridge(bridge)),
      icons: {},
    },
    commands,
    liveTerminals,
    turnOff,
  };
}

function build(
  model: ComputersModel,
  view: Partial<ComputersView> = {},
  ctx: ComputersContext = harness().ctx,
): ComputersDeck {
  return computersDeck(model, { path: [], filter: null, query: "", ...view }, ctx);
}

/** The list as `section: title` lines, the order a deck draws it in. */
function outline(deck: ComputersDeck): string[] {
  return deck.entries.map((entry) => `${entry.section ?? "-"}: ${entry.title}`);
}

function sections(deck: ComputersDeck): string[] {
  return [...new Set(deck.entries.map((entry) => entry.section ?? "-"))];
}

function row(deck: ComputersDeck, title: string): ComputersEntry {
  const found = deck.entries.filter((entry) => entry.title === title);
  if (found.length !== 1) {
    throw new Error(`${found.length} rows titled ${title}; listed: ${outline(deck).join(" | ")}`);
  }
  return found[0];
}

function titles(deck: ComputersDeck): string[] {
  return deck.entries.map((entry) => entry.title);
}

/** The card a row raises before it runs, as the deck would ask for it. */
async function ask(entry: ComputersEntry): Promise<DeckConfirm | undefined> {
  return typeof entry.confirm === "function" ? entry.confirm() : entry.confirm;
}

/** A desktop library: this machine, a connected and a disconnected devserver,
 * a tmux connection and a gateway. */
function desktopModel(over: Partial<ComputersModel> = {}): ComputersModel {
  return {
    machines: [
      local({
        workspaces: [
          space("local:chan", {
            name: "chan",
            windows: [win("local:w-1", { name: "Window 1", kind: "workspace", context: "chan" })],
          }),
          space("local:notes", { name: "notes", on: false, condition: "idle" }),
        ],
        windows: [win("local:t-1", { name: "Terminal Window 1" })],
      }),
      devserver("geekom", {
        detail: "http://geekom:8787",
        workspaces: [space("geekom:api", { name: "api" })],
        windows: [win("lib-g:t-1", { name: "Terminal Window 1" })],
      }),
      devserver("parked", { connection: "disconnected" }),
      {
        key: "tmux:tm-1",
        kind: "tmux",
        name: "tmux -CC on this machine (main)",
        attached: true,
        workspaces: [],
        windows: [win("local:tm-w", { name: "Terminal Window 2" })],
      },
    ],
    gateways: [gateway("gw-1", { name: "home", publicKey: true })],
    recent: [],
    may: DESKTOP,
    desktop: { theme: "dark", selecting: false },
    ...over,
  };
}

/** A devserver's own page: one machine, no registry of others. */
function devserverModel(over: Partial<ComputersModel> = {}): ComputersModel {
  return {
    machines: [
      local({
        workspaces: [
          space("local:chan", {
            name: "chan",
            windows: [win("local:w-1", { name: "Window 1", kind: "workspace", context: "chan" })],
          }),
        ],
        windows: [win("local:t-1", { name: "Terminal Window 1" })],
      }),
    ],
    may: DEVSERVER,
    ...over,
  };
}

// ---- The root -----------------------------------------------------------------

describe("the root", () => {
  it("lists the library in sections, objects before verbs", () => {
    const deck = build(desktopModel({ recent: ["lib-g:t-1", "local:w-1"] }));
    expect(outline(deck)).toEqual([
      "Needs attention: parked",
      "Recent windows: Terminal Window 1",
      "Recent windows: Window 1",
      "Computers: This machine",
      "Computers: geekom",
      "Computers: tmux -CC on this machine (main)",
      "Gateways: home",
      "New: New terminal",
      "New: New workspace",
      "New: Add devserver",
      "New: Add gateway",
      "Chan Desktop: Switch to light theme",
      "Chan Desktop: Select",
      "Chan Desktop: Quit",
    ]);
  });

  it("lists each object once and gives every row its own id", () => {
    const deck = build(desktopModel({ recent: ["lib-g:t-1", "local:w-1"] }));
    const ids = deck.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(titles(deck).filter((title) => title === "parked")).toHaveLength(1);
  });

  it("raises what needs attention, with the reason it gives", () => {
    const model = desktopModel();
    model.machines[1].lost = true;
    model.machines[0].workspaces[0].condition = "degraded";
    model.machines[0].workspaces[0].reason = "root is not readable";
    model.machines[0].windows[0].attention = "Not open here";
    const attention = build(model).entries.filter((entry) => entry.section === "Needs attention");
    expect(attention.map((entry) => [entry.title, entry.subtitle, entry.value])).toEqual([
      ["geekom", "http://geekom:8787", "connection lost"],
      ["parked", undefined, "disconnected"],
      ["chan", "root is not readable · This machine", "degraded"],
      ["Terminal Window 1", "Not open here · This machine", undefined],
    ]);
  });

  it("keeps at most five recent windows, most recent first, skipping the closed", () => {
    const windows = ["a", "b", "c", "d", "e", "f", "g"].map((key) => win(key));
    const deck = build(
      devserverModel({
        machines: [local({ windows })],
        recent: ["f", "gone", "b", "a", "g", "c", "d"],
      }),
    );
    const recent = deck.entries.filter((entry) => entry.section === "Recent windows");
    expect(recent.map((entry) => entry.title)).toEqual(["f", "b", "a", "g", "c"]);
    expect(
      deck.entries.filter((entry) => entry.section === "Windows").map((entry) => entry.title),
      "the rest follow under their own heading",
    ).toEqual(["d", "e"]);
  });

  it("stands on one machine without gateways or a desktop", () => {
    const deck = build(devserverModel());
    expect(outline(deck)).toEqual([
      "Workspaces: chan",
      "Windows: Terminal Window 1",
      "Windows: Window 1",
      "New: New terminal",
      "New: New workspace",
    ]);
  });

  it("runs New terminal on this machine in one step", async () => {
    const { ctx, commands } = harness();
    const terminal = row(build(devserverModel(), {}, ctx), "New terminal");
    expect(terminal.kind).toBeUndefined();
    expect(terminal.next).toBeUndefined();
    await terminal.run?.();
    expect(commands).toEqual([{ target: "machine", key: "local", action: "new-terminal" }]);
  });

  it("offers under New only what the host may add", () => {
    const deck = build(devserverModel({ may: { terminal: true, window: true } }));
    expect(deck.entries.filter((entry) => entry.section === "New").map((entry) => entry.title)).toEqual([
      "New terminal",
    ]);
  });

  it("names the theme it switches to and shows Select's state", async () => {
    const { ctx, commands } = harness();
    const deck = build(desktopModel({ desktop: { theme: "light", selecting: true } }), {}, ctx);
    expect(row(deck, "Switch to dark theme").section).toBe("Chan Desktop");
    const select = row(deck, "Select");
    expect([select.kind, select.value]).toEqual(["toggle", "on"]);
    await select.run?.();
    const quit = row(deck, "Quit");
    expect(quit.confirm).toEqual({
      title: "Quit Chan Desktop?",
      message: "Local workspaces and terminal sessions will stop.",
      actionLabel: "Quit",
      danger: true,
    });
    await quit.run?.();
    expect(commands).toEqual([
      { target: "app", action: "select" },
      { target: "app", action: "quit" },
    ]);
  });
});

// ---- Enter and Right ------------------------------------------------------------

describe("what a row does", () => {
  it("focuses a window on Enter and opens its page on Right", async () => {
    const { ctx, commands } = harness();
    const window = row(build(devserverModel(), {}, ctx), "Window 1");
    expect(window.expandable).toBe(true);
    expect(window.page).toEqual(["window:local:w-1"]);
    expect(window.subtitle, "the only machine is not named on every row").toBe("chan");
    await window.run?.();
    expect(commands).toEqual([{ target: "window", key: "local:w-1", action: "focus" }]);
  });

  it("runs the first action the host offers on a window", async () => {
    const { ctx, commands } = harness();
    const model = devserverModel({
      machines: [local({ windows: [win("n", { hidden: true, actions: ["show", "open", "close"] })] })],
    });
    const window = row(build(model, {}, ctx), "n");
    expect(window.value).toBe("hidden");
    await window.run?.();
    expect(commands).toEqual([{ target: "window", key: "n", action: "show" }]);
  });

  it("never closes a window from its own row", () => {
    const model = devserverModel({ machines: [local({ windows: [win("c", { actions: ["close"] })] })] });
    const window = row(build(model), "c");
    expect(window.kind).toBe("branch");
    expect(window.next).toEqual(["window:c"]);
    expect(window.run).toBeUndefined();
    expect(window.confirm).toBeUndefined();
  });

  it("opens a new window of a workspace on Enter and its page on Right", async () => {
    const { ctx, commands } = harness();
    const workspace = row(build(devserverModel(), {}, ctx), "chan");
    expect(workspace.expandable).toBe(true);
    expect(workspace.page).toEqual(["workspace:local:chan"]);
    expect(workspace.value).toBe("on");
    await workspace.run?.();
    expect(commands).toEqual([{ target: "workspace", key: "local:chan", action: "new-window" }]);
  });

  it("opens a machine's and a gateway's page on Enter", () => {
    const deck = build(desktopModel());
    const machine = row(deck, "geekom");
    expect([machine.kind, machine.next, machine.run]).toEqual(["branch", ["machine:geekom"], undefined]);
    expect([machine.subtitle, machine.value]).toEqual(["http://geekom:8787", "connected"]);
    const home = row(deck, "home");
    expect([home.kind, home.next, home.value]).toEqual(["branch", ["gateway:gw-1"], "connected"]);
  });

  it("marks the window this deck sits in", () => {
    const model = devserverModel({ machines: [local({ windows: [win("here", { current: true })] })] });
    expect(row(build(model), "here").subtitle).toBe("This window");
  });
});

describe("a row's second line", () => {
  it("names the machine where several are listed together", () => {
    const deck = build(desktopModel({ recent: ["lib-g:t-1", "local:w-1"] }));
    expect(row(deck, "Terminal Window 1").subtitle).toBe("geekom");
    expect(row(deck, "Window 1").subtitle).toBe("chan · This machine");
  });

  it("does not repeat the only machine there is", () => {
    const deck = build(devserverModel());
    expect([row(deck, "chan").subtitle, row(deck, "Terminal Window 1").subtitle]).toEqual([
      undefined,
      undefined,
    ]);
    const typed = build(devserverModel(), { query: "x" });
    expect([row(typed, "Turn off chan").subtitle, row(typed, "Turn off chan").breadcrumb]).toEqual([
      undefined,
      "Workspaces",
    ]);
    expect(row(typed, "Close Window 1").subtitle).toBe("chan");
  });

  it("does not repeat the machine a section or a page is named for", () => {
    const windows = build(desktopModel(), { filter: "windows" });
    expect(windows.entries.map((entry) => entry.subtitle)).toEqual([
      undefined,
      "chan",
      undefined,
      undefined,
      undefined,
    ]);
    const page = build(desktopModel(), { path: ["machine:geekom"] });
    expect(page.entries.map((entry) => entry.subtitle).filter(Boolean)).toEqual([]);
  });

  it("keeps the machine a workspace names when it is not the one that lists it", () => {
    const model = desktopModel();
    model.machines[1].workspaces[0].machine = "beta";
    expect(row(build(model, { filter: "workspaces" }), "api").subtitle).toBe("beta");
    expect(row(build(model, { path: ["machine:geekom"] }), "api").subtitle).toBe("beta");
  });

  it("leaves an object's own actions bare under its name, and its windows without it", () => {
    const deck = build(desktopModel(), { path: ["workspace:local:chan"] });
    expect(deck.entries.map((entry) => [entry.title, entry.subtitle])).toEqual([
      ["New window", undefined],
      ["New terminal window", undefined],
      ["Turn off", undefined],
      ["Window 1", undefined],
    ]);
  });
});

// ---- Pages ------------------------------------------------------------------------

describe("a machine's page", () => {
  it("lists its actions, then its workspaces, then its windows", () => {
    const deck = build(desktopModel(), { path: ["machine:local"] });
    expect(outline(deck)).toEqual([
      "Actions: New terminal",
      "Actions: New workspace",
      "Actions: Show on Computers screen",
      "Workspaces: chan",
      "Workspaces: notes",
      "Windows: Terminal Window 1",
      "Windows: Window 1",
    ]);
    expect(deck.crumbs).toEqual(["This machine"]);
    expect(deck.title).toBe("This machine");
  });

  it("offers a connected devserver its terminal, its disconnect and its config", async () => {
    const { ctx, commands } = harness();
    const deck = build(desktopModel(), { path: ["machine:geekom"] }, ctx);
    expect(deck.entries.filter((entry) => entry.section === "Actions").map((entry) => entry.title)).toEqual([
      "New terminal",
      "Disconnect",
      "Edit config",
      "Show on Computers screen",
    ]);
    const disconnect = row(deck, "Disconnect");
    expect(disconnect.danger).toBe(true);
    expect(disconnect.confirm).toEqual({
      title: "Disconnect geekom?",
      message: "Its Chan windows will close locally. The remote computer keeps running.",
      actionLabel: "Disconnect",
      danger: true,
    });
    for (const title of ["New terminal", "Disconnect", "Edit config", "Show on Computers screen"]) {
      await row(deck, title).run?.();
    }
    expect(commands.map((command) => "key" in command && [command.key, command.action])).toEqual([
      ["geekom", "new-terminal"],
      ["geekom", "disconnect"],
      ["geekom", "edit-config"],
      ["geekom", "show-card"],
    ]);
  });

  it("leaves a dialog's command to close the deck as it starts", () => {
    const deck = build(desktopModel(), { path: ["machine:geekom"] });
    expect(row(deck, "Edit config").awaitResult).toBe(false);
    expect(row(deck, "Show on Computers screen").awaitResult).toBe(false);
    expect(row(deck, "New terminal").awaitResult).toBe(true);
    expect(row(deck, "New terminal").dismissImmediatelyOnSuccess).toBe(true);
  });

  it("disconnects a connection that stopped answering before it connects again", () => {
    const model = desktopModel();
    model.machines[1].connection = "unreachable";
    const deck = build(model, { path: ["machine:geekom"] });
    expect(titles(deck)).toContain("Disconnect");
    expect(titles(deck)).not.toContain("Connect");
    expect(titles(deck), "no terminal on a lost connection").not.toContain("New terminal");
  });

  it("offers a shared gateway row its revoke behind a confirmation", () => {
    const model = desktopModel();
    model.machines[1] = devserver("geekom", { editable: false, revocable: true });
    const deck = build(model, { path: ["machine:geekom"] });
    expect(titles(deck)).not.toContain("Edit config");
    const revoke = row(deck, "Revoke native access");
    expect(revoke.danger).toBe(true);
    expect(revoke.confirm).toMatchObject({ title: "Revoke native access for geekom?", actionLabel: "Revoke" });
  });

  it("asks a tmux connection for a window or a detach", async () => {
    const { ctx, commands } = harness();
    const deck = build(desktopModel(), { path: ["machine:tmux:tm-1"] }, ctx);
    expect(outline(deck)).toEqual([
      "Actions: New tmux window",
      "Actions: Detach",
      "Actions: Show on Computers screen",
      "Windows: Terminal Window 2",
    ]);
    await row(deck, "New tmux window").run?.();
    await row(deck, "Detach").run?.();
    expect(commands).toEqual([
      { target: "machine", key: "tmux:tm-1", action: "new-tmux-window" },
      { target: "machine", key: "tmux:tm-1", action: "detach" },
    ]);
  });

  it("asks nothing of a tmux connection whose record has not arrived", () => {
    const model = desktopModel();
    model.machines[3].attached = false;
    expect(titles(build(model, { path: ["machine:tmux:tm-1"] }))).toEqual([
      "Show on Computers screen",
      "Terminal Window 2",
    ]);
  });

  it("reaches a page under a page and names both", () => {
    const { ctx } = harness();
    const machine = build(desktopModel(), { path: ["machine:local"] }, ctx);
    expect(row(machine, "chan").page).toEqual(["machine:local", "workspace:local:chan"]);
    const workspace = build(desktopModel(), { path: ["machine:local", "workspace:local:chan"] }, ctx);
    expect(workspace.crumbs).toEqual(["This machine", "chan"]);
    expect(outline(workspace)).toEqual([
      "Actions: New window",
      "Actions: New terminal window",
      "Actions: Turn off",
      "Windows: Window 1",
    ]);
    expect(row(workspace, "Window 1").page).toEqual([
      "machine:local",
      "workspace:local:chan",
      "window:local:w-1",
    ]);
  });

  it("falls back to the nearest page that still names an object", () => {
    const deck = build(desktopModel(), { path: ["machine:local", "window:local:closed"] });
    expect(deck.path).toEqual(["machine:local"]);
    expect(deck.title).toBe("This machine");
    expect(build(desktopModel(), { path: ["window:local:closed"] }).path).toEqual([]);
  });
});

describe("a window's page", () => {
  it("lists the host's actions in the cards' words", async () => {
    const { ctx, commands } = harness();
    const model = devserverModel({
      machines: [local({ windows: [win("n", { actions: ["focus", "show", "hide", "open", "close"] })] })],
    });
    const deck = build(model, { path: ["window:n"] }, ctx);
    expect(outline(deck)).toEqual([
      "Actions: Focus window",
      "Actions: Show window",
      "Actions: Hide window",
      "Actions: Open window",
      "Actions: Close window",
    ]);
    await row(deck, "Hide window").run?.();
    expect(commands).toEqual([{ target: "window", key: "n", action: "hide" }]);
    expect(row(deck, "Focus window").dismissImmediatelyOnSuccess).toBe(true);
    expect(row(deck, "Hide window").dismissImmediatelyOnSuccess).toBeFalsy();
  });

  it("asks before Close with the live count, then closes through the bridge", async () => {
    const { ctx, commands, liveTerminals } = harness();
    liveTerminals.mockResolvedValue(2);
    const close = row(build(devserverModel(), { path: ["window:local:w-1"] }, ctx), "Close window");
    expect(close.danger).toBe(true);
    expect(await ask(close)).toMatchObject({
      title: "Close Window 1?",
      message: "2 terminal sessions in this window will stop.",
    });
    expect(await close.run?.()).toBeUndefined();
    expect(commands).toEqual([{ target: "window", key: "local:w-1", action: "close" }]);
  });

  it("warns that a control terminal's close stops its script, without a count", async () => {
    const { ctx, commands, liveTerminals } = harness();
    const model = devserverModel({
      machines: [local({ windows: [win("ctl", { name: "Control terminal", control: true })] })],
    });
    const close = row(build(model, { path: ["window:ctl"] }, ctx), "Close window");
    expect(close.confirm).toEqual({
      title: "Close Control terminal?",
      message: "This stops the control terminal and its connection script.",
      actionLabel: "Close",
      danger: true,
    });
    await close.run?.();
    expect(liveTerminals).not.toHaveBeenCalled();
    expect(commands).toEqual([{ target: "window", key: "ctl", action: "close" }]);
  });
});

describe("a gateway's page", () => {
  it.each([
    ["disconnected", ["Connect", "Rename", "Copy WireGuard public key"]],
    ["connecting", ["Cancel connection", "Rename", "Copy WireGuard public key"]],
    ["connected", ["Disconnect", "Rename", "Copy WireGuard public key"]],
    ["unreachable", ["Disconnect", "Rename", "Copy WireGuard public key"]],
  ] as const)("offers a %s gateway its actions", (connection, expected) => {
    const model = desktopModel({ gateways: [gateway("gw-1", { name: "home", connection, publicKey: true })] });
    expect(titles(build(model, { path: ["gateway:gw-1"] }))).toEqual(expected);
  });

  it("carries each action to the bridge and confirms a disconnect", async () => {
    const { ctx, commands } = harness();
    const deck = build(desktopModel(), { path: ["gateway:gw-1"] }, ctx);
    expect(row(deck, "Disconnect").confirm).toMatchObject({ title: "Disconnect home?", danger: true });
    for (const title of ["Disconnect", "Rename", "Copy WireGuard public key"]) await row(deck, title).run?.();
    expect(commands).toEqual([
      { target: "gateway", key: "gw-1", action: "disconnect" },
      { target: "gateway", key: "gw-1", action: "rename" },
      { target: "gateway", key: "gw-1", action: "copy-wireguard-key" },
    ]);
  });

  it("offers no key to copy where the gateway has none", () => {
    const model = desktopModel({ gateways: [gateway("gw-1", { name: "home" })] });
    expect(titles(build(model, { path: ["gateway:gw-1"] }))).toEqual(["Disconnect", "Rename"]);
  });
});

// ---- Chained actions ----------------------------------------------------------------

describe("chained actions", () => {
  it("turns an off workspace on and opens it, where New window would be a dead end", async () => {
    const { ctx, commands } = harness();
    const page = build(desktopModel(), { path: ["workspace:local:notes"] }, ctx);
    expect(titles(page)).toEqual(["Turn on and open", "Turn on"]);
    const root = row(build(desktopModel(), { filter: "workspaces" }, ctx), "notes");
    expect([root.expandable, root.value]).toEqual([true, "off"]);
    await root.run?.();
    await row(page, "Turn on and open").run?.();
    expect(commands).toEqual([
      { target: "workspace", key: "local:notes", action: "turn-on-and-open" },
      { target: "workspace", key: "local:notes", action: "turn-on-and-open" },
    ]);
  });

  it("offers an off workspace nothing to open where the host cannot turn it on", () => {
    const model = desktopModel({ may: { terminal: true, window: true } });
    expect(titles(build(model, { path: ["workspace:local:notes"] }))).toEqual([]);
    const notes = row(build(model, { filter: "workspaces" }), "notes");
    expect([notes.kind, notes.run]).toEqual(["branch", undefined]);
  });

  it("connects a disconnected devserver and opens its terminal", async () => {
    const { ctx, commands } = harness();
    const deck = build(desktopModel(), { path: ["machine:parked"] }, ctx);
    expect(titles(deck)).toEqual(["Connect", "Connect and open", "Edit config", "Show on Computers screen"]);
    await row(deck, "Connect and open").run?.();
    expect(commands).toEqual([{ target: "machine", key: "parked", action: "connect-and-open" }]);
  });

  it.each([
    ["consent comes first", { trustRequired: true }],
    ["a sign-in is pending", { signIn: true }],
    ["its control terminal is open", { controlOpen: true }],
    ["a connect is in flight", { busy: true }],
  ] as const)("chains nothing after a connect when %s", (_why, state) => {
    const model = desktopModel();
    Object.assign(model.machines[2], state);
    expect(titles(build(model, { path: ["machine:parked"] }))).not.toContain("Connect and open");
  });

  it("chains nothing where the host opens no remote terminal", () => {
    const model = desktopModel({ may: { ...DESKTOP, remoteTerminal: false } });
    expect(titles(build(model, { path: ["machine:parked"] }))).toEqual([
      "Connect",
      "Edit config",
      "Show on Computers screen",
    ]);
  });
});

// ---- Rows that cannot run -------------------------------------------------------------

describe("a row that cannot run", () => {
  function workspacePage(over: Partial<ComputersWorkspace>): ComputersDeck {
    const model = devserverModel({ machines: [local({ workspaces: [space("w", { name: "w", ...over })] })] });
    return build(model, { path: ["workspace:w"] });
  }

  function reasons(deck: ComputersDeck): Record<string, string | undefined> {
    return Object.fromEntries(
      deck.entries.map((entry) => [entry.title, entry.disabled ? entry.subtitle : undefined]),
    );
  }

  it("shows the leader's reason on the rows that open a window, and keeps the power row", () => {
    expect(reasons(workspacePage({ leaderHeld: true }))).toEqual({
      "New window": COMPUTERS_REASONS.leader,
      "New terminal window": COMPUTERS_REASONS.leader,
      "Turn off": undefined,
    });
  });

  it("shows a pending operation on every row", () => {
    const working = {
      "New window": COMPUTERS_REASONS.working,
      "New terminal window": COMPUTERS_REASONS.working,
      "Turn off": COMPUTERS_REASONS.working,
    };
    expect(reasons(workspacePage({ busy: true }))).toEqual(working);
    expect(reasons(workspacePage({ condition: "busy" }))).toEqual(working);
  });

  it.each([
    ["foreign", COMPUTERS_REASONS.foreign],
    ["unknown", COMPUTERS_REASONS.lockUnknown],
  ] as const)("shows why a %s lock rules every row out", (condition, reason) => {
    expect(reasons(workspacePage({ condition }))).toEqual({
      "New window": reason,
      "New terminal window": reason,
      "Turn off": reason,
    });
  });

  it("keeps Turn off on a degraded workspace and gives the host's reason for the rest", () => {
    expect(reasons(workspacePage({ condition: "degraded", reason: "root is not readable" }))).toEqual({
      "New window": "root is not readable",
      "New terminal window": "root is not readable",
      "Turn off": undefined,
    });
    expect(reasons(workspacePage({ condition: "degraded" }))["New window"]).toBe(
      COMPUTERS_REASONS.unavailable,
    );
  });

  it("opens the page from a workspace whose New window cannot run", () => {
    const model = devserverModel({
      machines: [local({ workspaces: [space("w", { name: "w", condition: "degraded" })] })],
    });
    const workspace = row(build(model, { filter: "workspaces" }), "w");
    expect(workspace.disabled).toBeFalsy();
    expect([workspace.kind, workspace.next, workspace.run]).toEqual(["branch", ["workspace:w"], undefined]);
  });

  it("offers no confirmation on a disabled row", () => {
    const off = row(workspacePage({ condition: "foreign" }), "Turn off");
    expect(off.disabled).toBe(true);
    expect(off.confirm).toBeUndefined();
  });

  it("says why a disconnected devserver cannot connect yet", () => {
    const model = desktopModel();
    model.machines[2].controlOpen = true;
    const connect = row(build(model, { path: ["machine:parked"] }), "Connect");
    expect([connect.disabled, connect.subtitle]).toEqual([true, COMPUTERS_REASONS.controlOpen]);
    model.machines[2].controlOpen = false;
    model.machines[2].busy = true;
    expect(row(build(model, { path: ["machine:parked"] }), "Connect").subtitle).toBe(
      COMPUTERS_REASONS.working,
    );
  });

  it("shows a busy disconnect as working", () => {
    const model = desktopModel();
    model.machines[1].busy = true;
    const disconnect = row(build(model, { path: ["machine:geekom"] }), "Disconnect");
    expect([disconnect.disabled, disconnect.subtitle, disconnect.confirm]).toEqual([
      true,
      COMPUTERS_REASONS.working,
      undefined,
    ]);
  });

  it("says a connect is waiting on a sign-in", () => {
    const model = desktopModel();
    model.machines[2].signIn = true;
    const connect = row(build(model, { path: ["machine:parked"] }), "Connect");
    expect([connect.disabled, connect.value]).toEqual([undefined, "waiting for sign-in"]);
  });

  it("lists a window its host may not act on, disabled, with the reason", () => {
    const model = devserverModel({
      machines: [local({ windows: [win("held", { actions: [], blocked: "Only the tenant leader can show or hide this window" })] })],
    });
    const held = row(build(model), "held");
    expect([held.disabled, held.subtitle, held.run, held.next, held.page]).toEqual([
      true,
      "Only the tenant leader can show or hide this window",
      undefined,
      undefined,
      undefined,
    ]);
  });
});

// ---- Turn off ---------------------------------------------------------------------------

describe("Turn off", () => {
  it("asks once, on its own card, with the live count, and then stops the sessions", async () => {
    const { ctx, commands, liveTerminals, turnOff } = harness();
    liveTerminals.mockResolvedValue(2);
    turnOff.mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    const off = row(build(devserverModel(), { path: ["workspace:local:chan"] }, ctx), "Turn off");
    expect(off.danger).toBe(true);
    expect(await ask(off)).toEqual({
      title: "Turn off chan?",
      message: "2 terminal sessions in this workspace will stop.",
      actionLabel: "Turn off",
      danger: true,
    });
    expect(liveTerminals).toHaveBeenCalledExactlyOnceWith("workspace", "local:chan");
    expect(await off.run?.(), "no second question follows the card").toBeUndefined();
    expect(turnOff.mock.calls).toEqual([
      ["local:chan", false],
      ["local:chan", true],
    ]);
    expect(commands, "power does not go through the plain run").toEqual([]);
  });

  it("keeps its card across the rebuilds a live feed causes", async () => {
    const { ctx, liveTerminals, turnOff } = harness();
    liveTerminals.mockResolvedValue(1);
    turnOff.mockResolvedValueOnce(1).mockResolvedValueOnce(null);
    const first = row(build(devserverModel(), { path: ["workspace:local:chan"] }, ctx), "Turn off");
    await ask(first);
    const rebuilt = row(build(devserverModel(), { path: ["workspace:local:chan"] }, ctx), "Turn off");
    expect(await rebuilt.run?.()).toBeUndefined();
    expect(turnOff).toHaveBeenLastCalledWith("local:chan", true);
  });

  it("turns a workspace on without a question", async () => {
    const { ctx, commands } = harness();
    const on = row(build(desktopModel(), { path: ["workspace:local:notes"] }, ctx), "Turn on");
    expect(on.confirm).toBeUndefined();
    await on.run?.();
    expect(commands).toEqual([{ target: "workspace", key: "local:notes", action: "turn-on" }]);
  });

  it("says on the power row when the mount contradicts the wish", () => {
    const model = devserverModel({
      machines: [local({ workspaces: [space("w", { name: "w", on: false, condition: "ready" })] })],
    });
    const deck = build(model, { path: ["workspace:w"] });
    expect(row(deck, "Turn on").value).toBe("off, running");
    expect(titles(deck)).toEqual(["New window", "New terminal window", "Turn on"]);
  });
});

// ---- Typed search -------------------------------------------------------------------------

describe("typed search", () => {
  it("is flat over objects and their actions, each action reading verb then object", () => {
    const deck = build(devserverModel(), { query: "x" });
    expect(deck.entries.every((entry) => entry.section === undefined)).toBe(true);
    expect(titles(deck)).toEqual([
      "Terminal Window 1",
      "Focus Terminal Window 1",
      "Hide Terminal Window 1",
      "Close Terminal Window 1",
      "Window 1",
      "Focus Window 1",
      "Hide Window 1",
      "Close Window 1",
      "chan",
      "New window of chan",
      "New terminal window of chan",
      "Turn off chan",
      "This machine",
      "New terminal",
      "New workspace",
    ]);
  });

  it("puts the machine on an action's second line", () => {
    const deck = build(desktopModel(), { query: "x" });
    expect(row(deck, "New window of api").subtitle).toBe("geekom");
    expect(row(deck, "Close Window 1").subtitle).toBe("chan · This machine");
    expect(row(deck, "New terminal on geekom").subtitle).toBe("http://geekom:8787");
    expect(row(deck, "Connect and open parked").subtitle).toBeUndefined();
    expect(row(deck, "Turn on and open notes").subtitle).toBe("This machine");
    expect(row(deck, "Disconnect gateway home").breadcrumb).toBe("Gateways");
  });

  it("lets a query reach an action by the machine's name and by what privacy hides", () => {
    const model = devserverModel({
      machines: [
        local({
          workspaces: [
            space("w", {
              name: "Workspace",
              search: "secret-project /work/secret-project",
              windows: [win("x", { name: "Window", search: "release checks" })],
            }),
          ],
        }),
      ],
    });
    const deck = build(model, { query: "x" });
    expect(row(deck, "Turn off Workspace").searchText).toContain("secret-project");
    expect(row(deck, "Turn off Workspace").searchText).toContain("This machine");
    expect(row(deck, "Close Window").searchText).toContain("release checks");
    expect(row(deck, "Close Window").searchText).toContain("Close window");
  });

  it("keeps an old name findable as a keyword", () => {
    const deck = build(desktopModel(), { query: "x" });
    expect(row(deck, "Connect parked").searchText).toContain("reconnect");
    expect(row(deck, "Add devserver").searchText).toContain("new");
    expect(row(deck, "Turn on and open notes").searchText).toContain("new window");
    const native = devserverModel({
      machines: [local({ windows: [win("n", { name: "Window 3", actions: ["open", "hide", "close"] })] })],
    });
    expect(row(build(native, { query: "x" }), "Open Window 3").searchText).toContain("in this browser");
  });

  it("shows a row that cannot run, disabled, with its reason", () => {
    const model = desktopModel();
    model.machines[0].workspaces[0].leaderHeld = true;
    const blocked = row(build(model, { query: "x" }), "New window of chan");
    expect([blocked.disabled, blocked.subtitle]).toEqual([true, COMPUTERS_REASONS.leader]);
  });

  it("narrows to the type the rail filters by", () => {
    const deck = build(desktopModel(), { query: "x", filter: "gateways" });
    expect(titles(deck)).toEqual([
      "home",
      "Disconnect gateway home",
      "Rename gateway home",
      "Copy the WireGuard public key of home",
      "Add gateway",
    ]);
  });

  it("searches under the page it is typed on", () => {
    const deck = build(desktopModel(), { query: "x", path: ["machine:geekom"] });
    expect(deck.entries.every((entry) => entry.section === undefined)).toBe(true);
    expect(titles(deck)).toEqual([
      "New terminal",
      "Disconnect",
      "Edit config",
      "Show on Computers screen",
      "api",
      "New window of api",
      "New terminal window of api",
      "Turn off api",
      "Terminal Window 1",
      "Focus Terminal Window 1",
      "Hide Terminal Window 1",
      "Close Terminal Window 1",
    ]);
    expect(row(deck, "api").page).toEqual(["machine:geekom", "workspace:geekom:api"]);
  });
});

// ---- The rail --------------------------------------------------------------------------------

describe("the type filter", () => {
  it("is the rail: Windows, Workspaces, Computers, and Gateways where there is a registry", () => {
    expect(computersScopes(desktopModel(), {}).map((scope) => [scope.id, scope.label])).toEqual([
      ["windows", "Windows"],
      ["workspaces", "Workspaces"],
      ["computers", "Computers"],
      ["gateways", "Gateways"],
    ]);
    expect(computersScopes(devserverModel(), {}).map((scope) => scope.label)).toEqual([
      "Windows",
      "Workspaces",
      "Computers",
    ]);
  });

  it("reads a scope id back as its filter", () => {
    expect(computersFilter("computers")).toBe("machines");
    expect(computersFilter("windows")).toBe("windows");
    expect(computersFilter(null)).toBeNull();
    expect(computersFilter("tab")).toBeNull();
  });

  it("lists windows under their machines", () => {
    const deck = build(desktopModel({ unplaced: [win("lib-x:w", { name: "Control terminal" })] }), {
      filter: "windows",
    });
    expect(outline(deck)).toEqual([
      "This machine: Terminal Window 1",
      "This machine: Window 1",
      "geekom: Terminal Window 1",
      "tmux -CC on this machine (main): Terminal Window 2",
      "Connecting: Control terminal",
      "New: New terminal",
    ]);
    expect(deck.title).toBe("Windows");
  });

  it("lists workspaces under their machines", () => {
    expect(outline(build(desktopModel(), { filter: "workspaces" }))).toEqual([
      "This machine: chan",
      "This machine: notes",
      "geekom: api",
      "New: New workspace",
    ]);
  });

  it("lists every machine, and every gateway", () => {
    expect(outline(build(desktopModel(), { filter: "machines" }))).toEqual([
      "Computers: This machine",
      "Computers: geekom",
      "Computers: parked",
      "Computers: tmux -CC on this machine (main)",
      "New: Add devserver",
    ]);
    expect(outline(build(desktopModel(), { filter: "gateways" }))).toEqual([
      "Gateways: home",
      "New: Add gateway",
    ]);
  });

  it("tags each row with its type's scope", () => {
    const deck = build(desktopModel({ recent: ["local:w-1"] }));
    expect(row(deck, "Window 1").scope).toBe("windows");
    expect(row(deck, "geekom").scope).toBe("computers");
    expect(row(deck, "home").scope).toBe("gateways");
    expect(row(deck, "New workspace").scope).toBe("workspaces");
    expect(row(build(desktopModel(), { filter: "workspaces" }), "chan").scope).toBe("workspaces");
  });

  it("ignores a gateway filter where the host holds no registry", () => {
    expect(sections(build(devserverModel(), { filter: "gateways" }))).toEqual(["Workspaces", "Windows", "New"]);
  });
});

// ---- A window's scoped snapshot ----------------------------------------------------------------

describe("a host that holds one machine's snapshot", () => {
  const scopes = { windows: "computers", workspaces: "computers", machines: "computers", gateways: "computers" };

  function scoped(): { deck: ComputersDeck; commands: ComputersCommand[] } {
    const { ctx, commands } = harness();
    const model: ComputersModel = {
      machines: [
        local({
          workspaces: [space("ws-1", { name: "chan" })],
          windows: [win("w-2", { name: "Terminal Window 2", actions: ["focus", "hide", "close"] })],
        }),
      ],
      may: { terminal: true, window: true },
    };
    const deck = computersDeck(
      model,
      { path: [], filter: null, query: "" },
      { ...ctx, scopes, terminalTitle: "New terminal window" },
    );
    return { deck, commands };
  }

  it("lists its workspaces, its windows and a new terminal window, and nothing else", () => {
    const { deck } = scoped();
    expect(outline(deck)).toEqual([
      "Workspaces: chan",
      "Windows: Terminal Window 2",
      "New: New terminal window",
    ]);
    expect(deck.entries.every((entry) => entry.scope === "computers")).toBe(true);
  });

  it("offers a workspace a new window alone", () => {
    const { ctx } = harness();
    const model: ComputersModel = {
      machines: [local({ workspaces: [space("ws-1", { name: "chan" })] })],
      may: { terminal: true, window: true },
    };
    expect(titles(build(model, { path: ["workspace:ws-1"] }, ctx))).toEqual(["New window"]);
  });

  it("opens the terminal window as a leaf", async () => {
    const { deck, commands } = scoped();
    const terminal = row(deck, "New terminal window");
    expect(terminal.next).toBeUndefined();
    await terminal.run?.();
    expect(commands).toEqual([{ target: "machine", key: "local", action: "new-terminal" }]);
  });
});

// ---- Words ------------------------------------------------------------------------------------------

describe("state words", () => {
  it.each([
    [true, "ready", "on"],
    [false, "idle", "off"],
    [true, "busy", "on"],
    [false, "ready", "off, running"],
    [true, "idle", "on, stopped"],
    [true, "failed", "on, failed"],
    [true, "degraded", "degraded"],
    [false, "foreign", "locked"],
    [true, "unknown", "unknown"],
  ] as const)("reads a workspace wanted %s and found %s as %s", (on, condition, word) => {
    expect(workspaceStateWord({ on, condition })).toBe(word);
  });

  it.each([
    [{ connection: "connected" }, "connected"],
    [{ connection: "connected", lost: true }, "connection lost"],
    [{ connection: "unreachable" }, "connection lost"],
    [{ connection: "connecting" }, "connecting"],
    [{ connection: "disconnected", busy: true }, "connecting"],
    [{ connection: "disconnected" }, "disconnected"],
    [{}, undefined],
  ] as const)("reads a machine %o as %s", (machine, word) => {
    expect(connectionWord(machine)).toBe(word);
  });
});
