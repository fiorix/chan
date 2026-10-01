import { expect, test } from "vitest";

import { isInternalHref } from "./links";

test.each([
  ["https://x", false],
  ["mailto:a@b", false],
  ["#section", false],
  ["", false],
  ["x.md", true],
  ["./x.md", true],
  ["/x.md", true],
  ["../x.md", true],
])("classifies %j as an internal href: %j", (href, expected) => {
  expect(isInternalHref(href)).toBe(expected);
});
