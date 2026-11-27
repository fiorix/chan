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

vi.mock("../../../web/packages/launcher/src/api/backend", async () => {
    const { mockApi } = await import("../../../web/packages/launcher/src/api/mock");
    return { backend: mockApi };
});

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
    const { mockApi, resetMockRemoteWorkspaces } = await import(
        "../../../web/packages/launcher/src/api/mock"
    );
    const { library, loadLibrary, stopWatching } = await import(
        "../../../web/packages/launcher/src/state/library.svelte"
    );
    resetDeck();
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
    return { library, mockApi, stopWatching };
}

beforeEach(() => {
    vi.resetModules();
    setSurfaceMeta("desktop");
});

afterEach(() => {
    cleanupMount();
    vi.restoreAllMocks();
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

        const titles = [...mountTarget.querySelectorAll(".deck-result-title")].map(
            (el) => el.textContent?.trim() ?? "",
        );
        expect(titles.some((t) => t.startsWith("New terminal on "))).toBe(true);
        expect(titles.some((t) => t.startsWith("New terminal window of "))).toBe(true);
        expect(titles.some((t) => t.startsWith("Connect and open"))).toBe(true);

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
        const { library, mockApi, stopWatching } = await setupSeededLibrary();
        const { default: Library } = await import(
            "../../../web/packages/launcher/src/components/Library.svelte"
        );

        const termSpy = vi.spyOn(mockApi, "openDevserverTerminal");
        const wsSpy = vi.spyOn(mockApi, "openDevserverWorkspace");

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

        const titles = [...mountTarget.querySelectorAll(".deck-result-title")].map(
            (el) => el.textContent?.trim() ?? "",
        );
        expect(titles).not.toContain("New local terminal");
        expect(titles).not.toContain("New terminal on This machine");
        expect(titles).not.toContain("This machine");

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

        const titles = [...mountTarget.querySelectorAll(".deck-result-title")].map(
            (el) => el.textContent?.trim() ?? "",
        );
        expect(titles).not.toContain("New local workspace");
        expect(titles).not.toContain("New workspace");

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

        const titles = [...mountTarget.querySelectorAll(".deck-result-title")].map(
            (el) => el.textContent?.trim() ?? "",
        );
        expect(titles).not.toContain("This machine");
        expect(titles).not.toContain("New local terminal");
        expect(titles).not.toContain("New local workspace");

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
