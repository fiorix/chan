import { afterEach, expect, test } from "vitest";
import { privacy, setPrivacy } from "@chan/web-shared/privacy";
import { closeSettings, openSettings, settleSettings } from "../../__tests__/settings";

afterEach(async () => { closeSettings(); await setPrivacy({ enabled: false, mask_terminal_secrets: false }); });

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
