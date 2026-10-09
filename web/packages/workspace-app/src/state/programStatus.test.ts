import { expect, test } from "vitest";
import { effectiveProgramApp, presentProgramText, programVisual, type ProgramStatusRecord } from "./programStatus";

function record(source: "program" | "chan", id: string | null, app: string | null, order: number): ProgramStatusRecord {
  return { source, id, app, update_order: order, state: "idle", kind: null, progress: null, title: null, msg: null, seen: false };
}

test("app inheritance chooses the nearest extant ancestor of the same origin", () => {
  const programRoot = record("program", null, "root", 1);
  const programParent = record("program", "a", "parent", 2);
  const chanParent = record("chan", "a", "chan-app", 3);
  const child = record("program", "a/b/c", null, 4);
  const chanChild = record("chan", "a/b", null, 5);
  const status = { revision: 5, records: [programRoot, programParent, chanParent, child, chanChild] };
  expect([effectiveProgramApp(child, status), effectiveProgramApp(chanChild, status)]).toEqual(["parent", "chan-app"]);
});

test("a right to left override and invisible character are replaced before shortening", () => {
  expect(presentProgramText("a\u202Eb\u200Bc", 4)).toBe("a□b□…");
});

test("latest blocked record wins its tie and error wins over done", () => {
  const done = { ...record("program", null, null, 4), state: "done" as const };
  const error = { ...record("program", "error", null, 2), state: "error" as const };
  const older = { ...record("chan", "old", null, 3), state: "blocked" as const };
  const newer = { ...record("program", "new", null, 5), state: "blocked" as const };
  expect(programVisual({ revision: 5, records: [done, error, older, newer] }).attention?.id).toBe("new");
  expect(programVisual({ revision: 5, records: [done, error] }).attention?.state).toBe("error");
});
