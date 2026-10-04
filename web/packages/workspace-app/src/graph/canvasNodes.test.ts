import { expect, test } from "vitest";

import { directoryNodeId } from "./canvasNodes";

test("a directory's node id is its path under the directory prefix, and the root's is empty", () => {
  expect(directoryNodeId(""), "the workspace root").toBe("");
  expect(directoryNodeId("notes"), "a directory under the root").toBe("directory:notes");
  expect(directoryNodeId("notes/sub dir"), "a nested directory").toBe("directory:notes/sub dir");
});
