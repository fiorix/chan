import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevserverEntry } from "../../../web/packages/launcher/src/api/library";

const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC_DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const originalUa = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
const originalTouch = Object.getOwnPropertyDescriptor(Navigator.prototype, "maxTouchPoints");

function setNavigatorProfile({
    userAgent,
    platform,
    maxTouchPoints,
}: {
    userAgent: string;
    platform: string;
    maxTouchPoints: number;
}): void {
    Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
}

function setSurfaceMeta(content: string): void {
    document.head.querySelectorAll('meta[name="chan-launcher-surface"]').forEach((el) => el.remove());
    const meta = document.createElement("meta");
    meta.name = "chan-launcher-surface";
    meta.content = content;
    document.head.appendChild(meta);
}

let mountTarget: HTMLElement | null = null;
let mountedApp: Record<string, unknown> | null = null;
let cleanupUnmount: ((app: Record<string, unknown>) => void) | null = null;

function cleanupMount(): void {
    if (mountedApp && cleanupUnmount) {
        cleanupUnmount(mountedApp);
        mountedApp = null;
    }
    cleanupUnmount = null;
    mountTarget?.remove();
    mountTarget = null;
}

function deckTitles(root: HTMLElement): string[] {
    return [...root.querySelectorAll(".deck-result-title")].map(
        (el) => el.textContent?.trim() ?? "",
    );
}

async function queryDeck(root: HTMLElement, value: string): Promise<void> {
    const { flushSync, tick } = await import("svelte");
    const field = root.querySelector<HTMLInputElement>(".deck-input");
    expect(field).not.toBeNull();
    field!.value = value;
    field!.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    flushSync();
    await tick();
}

function makeOfflineDevserver(): DevserverEntry {
    return {
        id: "ds-off",
        url: "http://offline.example:8787",
        host: "offline.example",
        port: 8787,
        label: "offline-box",
        script: "",
        has_token: false,
        library_id: null,
        status: "disconnected",
        pending_signin: false,
        auto_hide_control: false,
        os: "linux",
        pretty_name: null,
        gateway_id: "gw-1",
        gateway_url: "https://gw.example",
        shared: false,
        native_trust_required: false,
        rows_hidden: false,
        connection_health: null,
    };
}

async function setupSeededLibrary({ emptyDevservers = false }: { emptyDevservers?: boolean } = {}) {
    const { resetDeck } = await import("../../../web/packages/launcher/src/state/deck.svelte");
    const { clearCommandLauncherDraft, clearRecentWindows } = await import(
        "../../../web/packages/launcher/src/state/commandLauncher.svelte"
    );
    const backendMod = await import("../../../web/packages/launcher/src/api/backend");
    const { mockApi, resetMockRemoteWorkspaces } = await import(
        "../../../web/packages/launcher/src/api/mock"
    );
    backendMod.setBackend(mockApi);
    const { backend } = backendMod;
    const { library, loadLibrary, stopWatching } = await import(
        "../../../web/packages/launcher/src/state/library.svelte"
    );
    resetDeck();
    clearCommandLauncherDraft();
    clearRecentWindows();
    resetMockRemoteWorkspaces();
    await loadLibrary();
    library.devservers = emptyDevservers
        ? []
        : [
              ...library.devservers.map((d) =>
                  d.id === "ds-1" ? { ...d, status: "connected" as const } : d,
              ),
              makeOfflineDevserver(),
          ];
    return { library, backend, mockApi, stopWatching };
}

beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    setSurfaceMeta("desktop");
});

afterEach(() => {
    cleanupMount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.querySelectorAll('meta[name="chan-launcher-surface"]').forEach((el) => el.remove());
    if (originalUa) Object.defineProperty(Navigator.prototype, "userAgent", originalUa);
    if (originalPlatform) Object.defineProperty(Navigator.prototype, "platform", originalPlatform);
    if (originalTouch) Object.defineProperty(Navigator.prototype, "maxTouchPoints", originalTouch);
});

describe("tier1", () => {
    it("f5-iphone-library-remote-buttons", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.isIOS).toBe(true);
        expect(caps.hasDesktopBridge).toBe(true);

        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const remoteTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label^="New terminal on "]',
        );
        expect(remoteTermBtn).not.toBeNull();
        expect(remoteTermBtn?.disabled).toBe(false);
        expect(remoteTermBtn?.closest(".offline-box")).toBeNull();

        const remoteWsTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label^="New terminal window of "]',
        );
        expect(remoteWsTermBtn).not.toBeNull();
        expect(remoteWsTermBtn?.disabled).toBe(false);

        stopWatching();
    });

    it("f5-iphone-command-launcher-remote", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const { stopWatching } = await setupSeededLibrary();
        const { openCommandLauncher, closeCommandLauncher } = await import(
            "../../../web/packages/launcher/src/state/commandLauncher.svelte"
        );
        const { default: CommandLauncher } = await import(
            "../../../web/packages/launcher/src/components/CommandLauncher.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(CommandLauncher, { target: mountTarget });
        openCommandLauncher();
        flushSync();
        await tick();

        const rootTitles = deckTitles(mountTarget);
        expect(rootTitles.length).toBeGreaterThanOrEqual(5);
        expect(rootTitles).toContain("prod");
        expect(rootTitles).toContain("offline-box");
        expect(rootTitles).toContain("Add devserver");
        expect(rootTitles).not.toContain("This machine");
        expect(rootTitles).not.toContain("New terminal");
        expect(rootTitles).not.toContain("New workspace");

        await queryDeck(mountTarget, "new terminal");
        const terminalTitles = deckTitles(mountTarget);
        expect(terminalTitles).toContain("New terminal on prod");
        expect(terminalTitles).toContain("New terminal window of api");

        await queryDeck(mountTarget, "connect and open");
        const connectTitles = deckTitles(mountTarget);
        expect(connectTitles).toContain("Connect and open offline-box");

        closeCommandLauncher();
        stopWatching();
    });

    it("f5-ipad-desktop-ua-remote-buttons", async () => {
        setNavigatorProfile({ userAgent: MAC_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.isIOS).toBe(true);

        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const remoteTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label^="New terminal on "]',
        );
        expect(remoteTermBtn).not.toBeNull();
        expect(remoteTermBtn?.disabled).toBe(false);

        const remoteWsTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label^="New terminal window of "]',
        );
        expect(remoteWsTermBtn).not.toBeNull();
        expect(remoteWsTermBtn?.disabled).toBe(false);

        stopWatching();
    });

    it("f5-iphone-remote-ws-terminal-click", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const { library, backend, mockApi, stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        expect(backend).toBe(mockApi);
        const termSpy = vi.spyOn(backend, "openDevserverTerminal");
        const wsSpy = vi.spyOn(backend, "openDevserverWorkspace");

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const remoteTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label="New terminal on prod"]',
        );
        expect(remoteTermBtn).not.toBeNull();
        const remoteWsTermBtn = mountTarget.querySelector<HTMLButtonElement>(
            'button[aria-label="New terminal window of api"]',
        );
        expect(remoteWsTermBtn).not.toBeNull();

        const beforeCount = library.windows.length;
        remoteTermBtn!.click();
        await new Promise((r) => setTimeout(r, 20));
        flushSync();
        await tick();

        remoteWsTermBtn!.click();
        await new Promise((r) => setTimeout(r, 20));
        flushSync();
        await tick();

        expect(termSpy).toHaveBeenCalledWith("ds-1");
        expect(wsSpy).toHaveBeenCalledWith("ds-1", "/srv/api", true);
        expect(library.windows.length).toBeGreaterThanOrEqual(beforeCount + 2);

        stopWatching();
    });

    it("f5-desktop-ua-negative-control", async () => {
        setNavigatorProfile({ userAgent: MAC_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 0 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.isIOS).toBe(false);

        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const labels = [...mountTarget.querySelectorAll("button[aria-label]")].map(
            (b) => b.getAttribute("aria-label") ?? "",
        );
        expect(mountTarget.textContent ?? "").toContain("This machine");
        expect(labels).toContain("New local terminal");

        stopWatching();
    });
});

describe("tier2", () => {
    it("f5-neg-no-this-machine-text", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        for (const emptyDevservers of [false, true]) {
            const { stopWatching } = await setupSeededLibrary({ emptyDevservers });
            mountTarget = document.createElement("div");
            document.body.appendChild(mountTarget);
            mountedApp = mount(Library, { target: mountTarget });
            flushSync();
            await tick();

            expect(mountTarget.querySelector('.slot[data-key="local"]')).toBeNull();
            expect(mountTarget.textContent ?? "").not.toContain("This machine");

            cleanupMount();
            stopWatching();
        }
    });

    it("f5-neg-no-new-local-terminal", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );
        const { openCommandLauncher, closeCommandLauncher } = await import(
            "../../../web/packages/launcher/src/state/commandLauncher.svelte"
        );
        const { default: CommandLauncher } = await import(
            "../../../web/packages/launcher/src/components/CommandLauncher.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const labels = [...mountTarget.querySelectorAll("button[aria-label]")].map(
            (b) => b.getAttribute("aria-label") ?? "",
        );
        expect(labels).not.toContain("New local terminal");
        cleanupMount();

        cleanupUnmount = unmount;
        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(CommandLauncher, { target: mountTarget });
        openCommandLauncher();
        flushSync();
        await tick();

        const localForbidden = [
            "New terminal",
            "New local terminal",
            "New terminal on This machine",
            "New workspace",
            "New local workspace",
            "This machine",
        ];
        const rootTitles = deckTitles(mountTarget);
        expect(rootTitles.length).toBeGreaterThanOrEqual(5);
        expect(rootTitles).toContain("prod");
        expect(rootTitles).toContain("offline-box");
        expect(rootTitles).toContain("Add devserver");
        for (const forbidden of localForbidden) {
            expect(rootTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new terminal");
        const termTitles = deckTitles(mountTarget);
        expect(termTitles).toContain("New terminal on prod");
        for (const forbidden of localForbidden) {
            expect(termTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new workspace");
        const wsTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(wsTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "this machine");
        const machineTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(machineTitles).not.toContain(forbidden);
        }

        closeCommandLauncher();
        stopWatching();
    });

    it("f5-neg-no-new-local-workspace", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );
        const { openCommandLauncher, closeCommandLauncher } = await import(
            "../../../web/packages/launcher/src/state/commandLauncher.svelte"
        );
        const { default: CommandLauncher } = await import(
            "../../../web/packages/launcher/src/components/CommandLauncher.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const labels = [...mountTarget.querySelectorAll("button[aria-label]")].map(
            (b) => b.getAttribute("aria-label") ?? "",
        );
        expect(labels).not.toContain("New local workspace");
        cleanupMount();

        cleanupUnmount = unmount;
        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(CommandLauncher, { target: mountTarget });
        openCommandLauncher();
        flushSync();
        await tick();

        const localForbidden = [
            "New terminal",
            "New local terminal",
            "New terminal on This machine",
            "New workspace",
            "New local workspace",
            "This machine",
        ];
        const rootTitles = deckTitles(mountTarget);
        expect(rootTitles.length).toBeGreaterThanOrEqual(5);
        expect(rootTitles).toContain("prod");
        expect(rootTitles).toContain("offline-box");
        expect(rootTitles).toContain("Add devserver");
        for (const forbidden of localForbidden) {
            expect(rootTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new terminal");
        const termTitles = deckTitles(mountTarget);
        expect(termTitles).toContain("New terminal on prod");
        for (const forbidden of localForbidden) {
            expect(termTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new workspace");
        const wsTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(wsTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "this machine");
        const machineTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(machineTitles).not.toContain(forbidden);
        }

        closeCommandLauncher();
        stopWatching();
    });

    it("f5-neg-ipad-ua-hides-local-entries", async () => {
        setNavigatorProfile({ userAgent: MAC_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.isIOS).toBe(true);
        expect(caps.isIOSUserAgent(MAC_DESKTOP_UA, "MacIntel", 1)).toBe(false);

        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );
        const { openCommandLauncher, closeCommandLauncher } = await import(
            "../../../web/packages/launcher/src/state/commandLauncher.svelte"
        );
        const { default: CommandLauncher } = await import(
            "../../../web/packages/launcher/src/components/CommandLauncher.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const labels = [...mountTarget.querySelectorAll("button[aria-label]")].map(
            (b) => b.getAttribute("aria-label") ?? "",
        );
        expect(mountTarget.textContent ?? "").not.toContain("This machine");
        expect(labels).not.toContain("New local terminal");
        expect(labels).not.toContain("New local workspace");
        cleanupMount();

        cleanupUnmount = unmount;
        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(CommandLauncher, { target: mountTarget });
        openCommandLauncher();
        flushSync();
        await tick();

        const localForbidden = [
            "New terminal",
            "New local terminal",
            "New terminal on This machine",
            "New workspace",
            "New local workspace",
            "This machine",
        ];
        const rootTitles = deckTitles(mountTarget);
        expect(rootTitles.length).toBeGreaterThanOrEqual(5);
        expect(rootTitles).toContain("prod");
        expect(rootTitles).toContain("offline-box");
        expect(rootTitles).toContain("Add devserver");
        for (const forbidden of localForbidden) {
            expect(rootTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new terminal");
        const termTitles = deckTitles(mountTarget);
        expect(termTitles).toContain("New terminal on prod");
        for (const forbidden of localForbidden) {
            expect(termTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "new workspace");
        const wsTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(wsTitles).not.toContain(forbidden);
        }

        await queryDeck(mountTarget, "this machine");
        const machineTitles = deckTitles(mountTarget);
        for (const forbidden of localForbidden) {
            expect(machineTitles).not.toContain(forbidden);
        }

        closeCommandLauncher();
        stopWatching();
    });

    it("f5-neg-readonly-surface-blocks-mutate", async () => {
        setSurfaceMeta("readonly");
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.readOnly).toBe(true);
        expect(caps.canMutateRegistry).toBe(false);

        const { stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );
        const { activeCommandLauncherDraft, closeCommandLauncher } = await import(
            "../../../web/packages/launcher/src/state/commandLauncher.svelte"
        );
        const { default: CommandLauncher } = await import(
            "../../../web/packages/launcher/src/components/CommandLauncher.svelte"
        );

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(Library, { target: mountTarget });
        flushSync();
        await tick();

        const labels = [...mountTarget.querySelectorAll("button[aria-label]")].map(
            (b) => b.getAttribute("aria-label") ?? "",
        );
        expect(labels.some((l) => l.startsWith("New window of "))).toBe(false);
        expect(labels.some((l) => l.startsWith("New terminal window of "))).toBe(false);
        expect(labels).not.toContain("New local terminal");
        expect(labels).not.toContain("New local workspace");
        cleanupMount();

        cleanupUnmount = unmount;
        closeCommandLauncher();
        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(CommandLauncher, { target: mountTarget });
        flushSync();
        await tick();

        window.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "k",
                ctrlKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        flushSync();
        expect(activeCommandLauncherDraft().visible).toBe(false);

        stopWatching();
    });
});

describe("tier3", () => {
    it("t3-f4-f5-ios-launcher-remote-open-unhides-and-stamps-url", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        setSurfaceMeta("desktop");
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;
        const caps = await import("../../../web/packages/launcher/src/state/capabilities");
        expect(caps.isIOS).toBe(true);
        expect(caps.hasDesktopBridge).toBe(true);

        const { backend, stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );
        const { windowUrl } = await import(
            "../../../web/packages/launcher/src/lib/windowUrl"
        );
        const { verifyWindowNavigationParams } = await import("./ios-wireguard-oracle.mjs");
        type WindowSet = import("../../../web/packages/launcher/src/api/library").WindowSet;

        const openWindowSpy = vi.spyOn(backend, "openWindow");
        const openWsSpy = vi.spyOn(backend, "openDevserverWorkspace");
        const openTermSpy = vi.spyOn(backend, "openDevserverTerminal");

        const feedSnapshots: WindowSet[] = [];
        const unwatch = backend.watchWindows((set) => {
            feedSnapshots.push(structuredClone(set));
        });

        try {
            mountTarget = document.createElement("div");
            document.body.appendChild(mountTarget);
            mountedApp = mount(Library, { target: mountTarget });
            flushSync();
            await tick();

            expect(mountTarget.querySelector('.slot[data-key="local"]')).toBeNull();
            expect(mountTarget.textContent ?? "").not.toContain("This machine");

            const allWindowsSlot = mountTarget.querySelector('.slot.active[data-key="all-windows"]');
            expect(allWindowsSlot).not.toBeNull();
            expect(allWindowsSlot?.getAttribute("aria-current")).toBe("true");

            const hiddenRow = mountTarget.querySelector<HTMLLIElement>(
                'li[data-window-id="w-ds1-term-1"]',
            );
            expect(hiddenRow).not.toBeNull();
            expect(hiddenRow?.textContent ?? "").toContain("prod · Hidden");
            const showBtn = hiddenRow!.querySelector<HTMLButtonElement>(
                'button[aria-label="Show window"]',
            );
            expect(showBtn).not.toBeNull();

            showBtn!.click();
            await new Promise((r) => setTimeout(r, 20));
            flushSync();
            await tick();

            expect(openWindowSpy).toHaveBeenCalledWith("w-ds1-term-1");
            const latestAfterOpen = feedSnapshots.at(-1);
            expect(latestAfterOpen).toBeDefined();
            const unhiddenRec = latestAfterOpen!.windows.find(
                (w) => w.window_id === "w-ds1-term-1",
            );
            expect(unhiddenRec).toBeDefined();
            expect(unhiddenRec!.hidden).toBe(false);
            expect(unhiddenRec!.connected).toBe(true);

            const updatedRow = mountTarget.querySelector<HTMLLIElement>(
                'li[data-window-id="w-ds1-term-1"]',
            );
            expect(updatedRow?.textContent ?? "").toContain("prod · Shown");
            expect(
                updatedRow?.querySelector('button[aria-label="Hide window"]'),
            ).not.toBeNull();

            const remoteOrigin = "https://alice--0123456789ab.p1.localtest.me";
            verifyWindowNavigationParams(windowUrl(unhiddenRec!, remoteOrigin), {
                windowId: "w-ds1-term-1",
                kind: "terminal",
                libraryId: "lib-7f3a9c21b40d8e65",
            });

            const prodDot = mountTarget.querySelector<HTMLButtonElement>('.dot[title="prod"]');
            expect(prodDot).not.toBeNull();
            prodDot!.click();
            flushSync();
            await tick();
            const prodSlot = mountTarget.querySelector('.slot.active[data-key="ds-1"]');
            expect(prodSlot).not.toBeNull();
            expect(prodSlot?.getAttribute("aria-current")).toBe("true");

            const newWsBtn = mountTarget.querySelector<HTMLButtonElement>(
                'button[aria-label="New terminal window of api"]',
            );
            const newTermBtn = mountTarget.querySelector<HTMLButtonElement>(
                'button[aria-label="New terminal on prod"]',
            );
            expect(newWsBtn).not.toBeNull();
            expect(newTermBtn).not.toBeNull();

            newWsBtn!.click();
            newTermBtn!.click();
            await new Promise((r) => setTimeout(r, 20));
            flushSync();
            await tick();

            expect(openWsSpy).toHaveBeenCalledWith("ds-1", "/srv/api", true);
            expect(openTermSpy).toHaveBeenCalledWith("ds-1");

            const latestAfterMint = feedSnapshots.at(-1)!;
            const wsRec = latestAfterMint.windows.find(
                (w) =>
                    w.library_id === "lib-7f3a9c21b40d8e65" &&
                    w.kind === "workspace" &&
                    w.start_terminal === true &&
                    w.workspace_path === "/srv/api",
            );
            const termRec = latestAfterMint.windows.find(
                (w) =>
                    w.library_id === "lib-7f3a9c21b40d8e65" &&
                    w.kind === "terminal" &&
                    w.token === "tok_remote_term",
            );
            const ctrlRec = latestAfterMint.windows.find(
                (w) => w.window_id === "w-ds1-control",
            );
            expect(wsRec).toBeDefined();
            expect(termRec).toBeDefined();
            expect(ctrlRec).toBeDefined();

            const expandApi = prodSlot!.querySelector<HTMLButtonElement>(
                'button[aria-label="Expand api"]',
            );
            expect(expandApi).not.toBeNull();
            expandApi!.click();
            flushSync();
            await tick();
            const wsWindows = prodSlot!.querySelector(".ws-windows");
            expect(wsWindows).not.toBeNull();
            expect(wsWindows!.querySelectorAll(".row[data-deck-row]")).toHaveLength(2);
            expect(wsWindows!.textContent ?? "").toContain("Window 1");

            verifyWindowNavigationParams(windowUrl(wsRec!, remoteOrigin), {
                windowId: wsRec!.window_id,
                kind: "workspace",
                startTerminal: true,
                libraryId: "lib-7f3a9c21b40d8e65",
                preservedToken: "tok_remote_ws",
            });
            verifyWindowNavigationParams(windowUrl(termRec!, remoteOrigin), {
                windowId: termRec!.window_id,
                kind: "terminal",
                libraryId: "lib-7f3a9c21b40d8e65",
                preservedToken: "tok_remote_term",
            });
            verifyWindowNavigationParams(windowUrl(ctrlRec!, remoteOrigin), {
                windowId: "w-ds1-control",
                kind: "control",
                libraryId: "lib-7f3a9c21b40d8e65",
                preservedToken: "tok_ds1_control",
            });
        } finally {
            unwatch();
            stopWatching();
        }
    });

    it("t3-f5-f8-ios-launcher-to-window-and-all-computers-back", async () => {
        setNavigatorProfile({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
        setSurfaceMeta("desktop");
        const { flushSync, mount, tick, unmount } = await import("svelte");
        cleanupUnmount = unmount;

        const backendMod = await import(
            "../../../web/packages/launcher/src/api/backend"
        );
        const { mockApi, resetMockRemoteWorkspaces } = await import(
            "../../../web/packages/launcher/src/api/mock"
        );
        const { library, stopWatching } = await import(
            "../../../web/packages/launcher/src/state/library.svelte"
        );
        const { decks, resetDeck } = await import(
            "../../../web/packages/launcher/src/state/deck.svelte"
        );
        const { screen } = await import(
            "../../../web/packages/launcher/src/state/screen.svelte"
        );
        const {
            activeCommandLauncherDraft,
            clearCommandLauncherDraft,
            clearRecentWindows,
            closeCommandLauncher,
        } = await import("../../../web/packages/launcher/src/state/commandLauncher.svelte");
        const { clearNotices } = await import(
            "../../../web/packages/launcher/src/state/notices.svelte"
        );
        const { default: App } = await import(
            "../../../web/packages/launcher/src/App.svelte"
        );

        resetDeck();
        screen.current = "computers";
        screen.flips = 0;
        clearCommandLauncherDraft();
        closeCommandLauncher();
        clearRecentWindows();
        clearNotices();
        resetMockRemoteWorkspaces();
        backendMod.setBackend(mockApi);

        const openTermSpy = vi.spyOn(backendMod.backend, "openDevserverTerminal");

        let pendingCard: string | null = "ds-1";
        let cardListener: ((event: { payload: { devserverId: string | null } }) => void) | null =
            null;
        const invoke = vi.fn(async (cmd: string) => {
            if (cmd === "mobile_deliver_pending_show_card") {
                if (pendingCard !== null && cardListener) {
                    const id = pendingCard;
                    pendingCard = null;
                    cardListener({ payload: { devserverId: id } });
                }
                return null;
            }
            return null;
        });
        const listen = vi.fn(
            async (
                eventName: string,
                cb: (event: { payload: { devserverId: string | null } }) => void,
            ) => {
                if (eventName === "launcher-show-devserver-card") {
                    cardListener = cb;
                }
                return () => {
                    if (eventName === "launcher-show-devserver-card" && cardListener === cb) {
                        cardListener = null;
                    }
                };
            },
        );
        vi.stubGlobal("__TAURI__", { core: { invoke }, event: { listen } });

        mountTarget = document.createElement("div");
        document.body.appendChild(mountTarget);
        mountedApp = mount(App, { target: mountTarget, props: { animatedBackground: false } });
        flushSync();

        try {
            expect(library.loaded).toBe(false);
            await tick();
            expect(cardListener).not.toBeNull();

            await invoke("mobile_deliver_pending_show_card");
            flushSync();
            expect(decks.computers.activeKey).toBe("ds-1");

            await new Promise((r) => setTimeout(r, 20));
            flushSync();
            await tick();

            expect(library.loaded).toBe(true);
            expect(mountTarget.querySelector(".key-bar")).toBeNull();
            expect(mountTarget.querySelector('.slot[data-key="local"]')).toBeNull();
            expect(screen.current).toBe("computers");
            expect(decks.computers.activeKey).toBe("ds-1");
            const prodSlot = mountTarget.querySelector('.slot.active[data-key="ds-1"]');
            expect(prodSlot).not.toBeNull();
            expect(prodSlot?.getAttribute("aria-current")).toBe("true");

            const titleToggle = mountTarget.querySelector<HTMLButtonElement>("button.title-toggle");
            expect(titleToggle).not.toBeNull();
            titleToggle!.click();
            flushSync();
            await tick();
            expect(screen.current).toBe("gateways");
            expect(mountTarget.querySelector(".gateways-screen")).not.toBeNull();

            pendingCard = "local";
            await invoke("mobile_deliver_pending_show_card");
            flushSync();
            await tick();
            expect(screen.current).toBe("computers");
            expect(decks.computers.activeKey).toBe("all-windows");
            const allWinSlot = mountTarget.querySelector('.slot.active[data-key="all-windows"]');
            expect(allWinSlot).not.toBeNull();
            expect(allWinSlot?.getAttribute("aria-current")).toBe("true");
            expect(mountTarget.querySelector('.slot[data-key="local"]')).toBeNull();

            const openLauncherBtn = mountTarget.querySelector<HTMLButtonElement>(
                'button[aria-label="Open command launcher"]',
            );
            expect(openLauncherBtn).not.toBeNull();
            openLauncherBtn!.click();
            flushSync();
            await tick();

            const dialog = mountTarget.querySelector('[role="dialog"][aria-label="Command launcher"]');
            expect(dialog).not.toBeNull();

            await queryDeck(mountTarget, "new terminal");
            const titles = deckTitles(mountTarget);
            for (const forbidden of [
                "New terminal",
                "New local terminal",
                "New workspace",
                "This machine",
            ]) {
                expect(titles).not.toContain(forbidden);
            }
            const prodBtn = [...mountTarget.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
                (btn) => btn.querySelector(".deck-result-title")?.textContent?.trim() === "New terminal on prod",
            );
            expect(prodBtn).toBeDefined();

            const beforeCount = library.windows.length;
            prodBtn!.click();
            await new Promise((r) => setTimeout(r, 20));
            flushSync();
            await tick();

            expect(openTermSpy).toHaveBeenCalledTimes(1);
            expect(openTermSpy).toHaveBeenCalledWith("ds-1");
            expect(activeCommandLauncherDraft().visible).toBe(false);
            expect(library.windows.length).toBeGreaterThan(beforeCount);

            const esc = new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
            });
            window.dispatchEvent(esc);
            expect(esc.defaultPrevented).toBe(true);
            expect(invoke).toHaveBeenCalledWith("toggle_launcher_panel", undefined);
        } finally {
            stopWatching();
            closeCommandLauncher();
            clearCommandLauncherDraft();
            clearNotices();
            vi.unstubAllGlobals();
        }
    });
});
