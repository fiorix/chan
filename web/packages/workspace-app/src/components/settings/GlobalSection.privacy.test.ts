import { afterEach, expect, test } from "vitest";
import { privacy, setPrivacy } from "@chan/web-shared/privacy";
import { closeSettings, openSettings, settleSettings } from "../../__tests__/settings";

afterEach(async () => { closeSettings(); await setPrivacy({ enabled: false, mask_terminal_secrets: false }); });

test("Global privacy hint names the concealed surfaces and the field reveal limit", async () => {
  const { target } = await openSettings("Global");
  const heading = [...target.querySelectorAll("h3")].find((node) => node.textContent === "Privacy mode");
  const hint = heading?.closest("section")?.querySelector(".hint")?.textContent ?? "";
  for (const detail of [
    "computer and gateway names", "addresses", "connection scripts and tokens",
    "workspace paths in Computers", "WireGuard file paths and public keys", "connection errors",
    "launcher notices and action details", "window labels in Computers", "window titles",
    "window titles, terminal program details", "Metrics slide's host name and chan home path",
    "where an eye button is shown", "Shared across Chan desktop windows, or browser tabs at the same address",
    "Screen recording is not detected automatically",
    "the command launcher's window labels and workspace names", "the Workspace slide's root path",
  ]) expect.soft(hint).toContain(detail);
  // The pane list has no heading: the window tab bar carries the window's
  // title, which "window titles" covers.
  expect.soft(hint).not.toContain("pane list");
});

test("Global privacy controls save on the viewing client without changing tenant preferences", async () => {
  const { target, writes } = await openSettings("Global");
  const label = [...target.querySelectorAll("label")].find((node) => node.textContent?.includes("Privacy mode on"))!;
  const checkbox = label.querySelector("input")!;
  checkbox.click();
  await settleSettings();
  expect(privacy.enabled).toBe(true);
  expect(JSON.parse(localStorage.getItem("chan.privacy.v1")!).enabled).toBe(true);
  expect(writes).toEqual([]);
});
