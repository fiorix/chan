// @vitest-environment jsdom

// The index/build progress pill stays visible while the indexer is
// working and CLEARS the moment it reports idle. This test locks the
// AppStatusBar visibility rule so a future status-flow change can't
// silently strand the pill.
//
// AppStatusBar derives `indexVisible` from the shared `indexStatus`
// store; we workspace the store directly and assert the same predicate, plus
// pin the source so the derivation and the template branch stay in
// lockstep.

import { afterEach, describe, expect, test } from "vitest";
import statusBar from "./AppStatusBar.svelte?raw";
import { indexStatus } from "../state/store.svelte";
import type { IndexStatus } from "../api/types";

/// The exact predicate AppStatusBar uses for `indexVisible`. Kept here
/// as the spec; the source-pinning test below guards that the component
/// still computes it this way. Idle hides EXCEPT when a background
/// `embedding` is set (BM25-ready, embeddings still generating) - that
/// surfaces a passive chip.
function indexVisible(value: IndexStatus | null): boolean {
  return (
    value !== null &&
    (value.state !== "idle" || value.embedding != null)
  );
}

afterEach(() => {
  indexStatus.value = null;
});

describe("index progress pill visibility", () => {
  test("hidden before the first poll reply (null)", () => {
    indexStatus.value = null;
    expect(indexVisible(indexStatus.value)).toBe(false);
  });

  test("visible while building (counter + file animate through embed)", () => {
    indexStatus.value = {
      state: "building",
      current: 42,
      total: 100,
      file: "embedding",
    } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(true);
  });

  test("visible while reindexing a single file", () => {
    indexStatus.value = { state: "reindexing", file: "notes/x.md" } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(true);
  });

  test("visible on error", () => {
    indexStatus.value = { state: "error", message: "boom" } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(true);
  });

  test("visible while the workspace is recovering", () => {
    indexStatus.value = {
      state: "recovering",
      readiness: { state: "recovering" },
    };
    expect(indexVisible(indexStatus.value)).toBe(true);
  });

  test("CLEARS the moment the indexer reports settled idle (bug 9)", () => {
    indexStatus.value = {
      state: "building",
      current: 99,
      total: 100,
      file: "embedding",
    } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(true);

    // The indexer guarantees the status reaches idle; with no
    // background embedding left, the pill must hide.
    indexStatus.value = { state: "idle" } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(false);
  });

  test("STAYS visible on idle while background embedding runs (passive chip)", () => {
    // BM25-ready (preflight unlocked) but embeddings still generating in
    // the background -> a passive progress chip, not a hidden pill.
    indexStatus.value = {
      state: "idle",
      indexed_docs: 10,
      indexed_vectors: 4,
      model: "BAAI/bge-small-en-v1.5",
      embedding: { done: 4, total: 10 },
    } as IndexStatus;
    expect(indexVisible(indexStatus.value)).toBe(true);
  });
});

describe("AppStatusBar source keeps the idle-hide rule (except embedding)", () => {
  test("indexVisible derivation hides on idle/null but shows idle+embedding", () => {
    expect(statusBar).toMatch(
      /indexStatus\.value !== null &&[\s\S]{1,40}indexStatus\.value\.state !== "idle" \|\|[\s\S]{1,60}indexStatus\.value\.embedding != null/,
    );
  });

  test("idle+embedding renders a passive chip: static dot + embedding count", () => {
    expect(statusBar).toMatch(/s\.state === "idle" && s\.embedding/);
    expect(statusBar).toMatch(
      /\{s\.embedding\.done\}\/\{s\.embedding\.total\}/,
    );
    // Passive: the dot does NOT pulse (`working`) on idle, only on the
    // active building / reindexing states.
    expect(statusBar).toMatch(
      /class:working=\{s\.state !== "error" && s\.state !== "idle"\}/,
    );
  });

  test("building branch surfaces the animated counter so the embed phase isn't a frozen pill", () => {
    expect(statusBar).toMatch(/s\.state === "building"/);
    expect(statusBar).toMatch(/\{s\.current\}\/\{s\.total\}/);
  });

  test("recovery branch names the rebuild AND that search is paused", () => {
    // The pill is now the primary "why is search quiet" signal for a user who
    // is INSIDE a working workspace: the boot overlay stopped locking behind a
    // recovery pass, so nothing else stops them reaching a search box first.
    expect(statusBar).toMatch(
      /\{:else if s\.state === "recovering"\}[\s\S]{1,200}rebuilding search index/,
    );
    expect(statusBar).toMatch(/rebuilding search index[\s\S]{1,80}search paused/);
  });

  test("counter hides during the embedding-sentinel sub-phase", () => {
    // The IndexFile / GraphRebuild stages set current/total to
    // "files indexed / total files" - readable. The EmbedBatch
    // stage (sentinel `s.file === "embedding"`) instead reports
    // chunks pending / batch budget, which once chunks exceed the
    // budget reads as nonsense ("indexing 4143/4096 (embedding)").
    // Hide the counter in that sub-phase so the pill just signals
    // "embedding in progress".
    expect(statusBar).toMatch(
      /\{#if s\.state === "building"\}[\s\S]{1,1500}\{#if s\.file !== "embedding"\}[\s\S]{1,300}\{s\.current\}\/\{s\.total\}/,
    );
  });
});
