import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const script = readFileSync("../../../desktop/src/about.js", "utf8");
const page = readFileSync("../../../desktop/src/about.html", "utf8");
let invoke: ReturnType<typeof vi.fn>;
let openUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(page, "text/html").body.innerHTML;
  invoke = vi.fn().mockResolvedValue(undefined);
  openUrl = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI__", { core: { invoke }, opener: { openUrl } });
  new Function(script)();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("About links", () => {
  test("every shipped external link uses the chan command without navigating", () => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a.ext")];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenLastCalledWith("open_external_url", { url: link.getAttribute("href") });
    }
    expect(invoke).toHaveBeenCalledTimes(links.length);
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("an absent href opens nothing", () => {
    const link = document.querySelector<HTMLAnchorElement>("a.ext")!;
    link.removeAttribute("href");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("a refused open stays in the About page and logs the error", async () => {
    const error = new Error("no default browser");
    invoke.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = document.querySelector<HTMLAnchorElement>("a.ext")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(true);
    expect(warn).toHaveBeenCalledWith("open_external_url failed:", error);
    expect(open).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
