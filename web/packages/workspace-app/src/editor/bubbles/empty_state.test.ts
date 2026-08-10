import { describe, expect, test } from "vitest";
import {
  completionEmptyState,
  indexedDocumentCount,
  indexInProgress,
} from "./empty_state";
import type { IndexStatus } from "../../api/types";

describe("bubble empty states", () => {
  test("empty query asks the user to type", () => {
    expect(completionEmptyState("", null)).toEqual({
      kind: "empty",
      primary: "Empty search, type something",
    });
  });

  test("building status reports documents searched so far", () => {
    const status: IndexStatus = {
      state: "building",
      current: 7,
      total: 20,
      file: "a.md",
    };
    expect(indexInProgress(status)).toBe(true);
    expect(indexedDocumentCount(status)).toBe(7);
    expect(completionEmptyState("note", status)).toEqual({
      kind: "indexing",
      primary: "Indexing...",
      secondary: "searched 7 documents so far",
    });
  });

  test("recovering status never reports a fresh-looking empty index", () => {
    const status: IndexStatus = {
      state: "recovering",
      readiness: { state: "recovering" },
    };
    expect(indexInProgress(status)).toBe(true);
    expect(completionEmptyState("note", status)).toEqual({
      kind: "indexing",
      primary: "Rebuilding search index...",
      secondary: "content search is paused until it finishes",
    });
  });

  test("idle status reports no matches against indexed document count", () => {
    const status: IndexStatus = {
      state: "idle",
      indexed_docs: 1,
      indexed_vectors: 0,
      model: "bm25",
    };
    expect(completionEmptyState("missing", status)).toEqual({
      kind: "none",
      primary: "No matches in 1 document.",
      secondary: "",
    });
  });
});
