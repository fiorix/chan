// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import JsonPretty from "./JsonPretty.svelte";

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

test("a buffer that does not parse shows the parse error and how to fix it", () => {
  const broken = '{ "name": "chan", }';
  let message = "";
  try {
    JSON.parse(broken);
  } catch (e) {
    message = (e as Error).message;
  }
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(JsonPretty, { target, props: { value: broken } }));
  const error = target.querySelector(".parse-error");

  expect({
    message: error?.querySelector("span")?.textContent,
    hint: error?.querySelector(".hint")?.textContent?.replace(/\s+/g, " ").trim(),
  }).toEqual({ message, hint: "Flip back to Source to fix the syntax." });
});
