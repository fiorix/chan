// @vitest-environment jsdom
//
// The widgets that read the syntax tree rescan when the tree changes. Each
// editor here is built with its creation parse cut after its first slice,
// and forceParsing then completes the tree in a transaction that changes
// neither the document nor the selection and carries no effect: a widget
// that waits for one of those keeps the decorations of the short tree. The
// marks skip code ranges the short tree does not hold yet, so a word inside
// a fence is marked until the rescan; the link providers find no link node
// in the short tree, so a link is undrawn until it.

import { afterEach, expect, test, vi } from "vitest";
import { forceParsing, syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { api } from "../../api/client";
import { viewWithShortParse } from "../../__tests__/shortParse";
import { chanMarkdown } from "../markdown/grammar";
import { dateDecorations } from "./date";
import { mentionDecorations } from "./mention";
import { tagDecorations } from "./tag";
import { inlineCodeLinkDecorations, inlineCodeLinkTarget, wikiLinkDecorations } from "./wikilink";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/// Build the short-parse editor, check that its tree stops before `target`,
/// complete the tree as forceParsing does, and answer the texts of the
/// elements `selector` matches.
function afterForcedParse(doc: string, extension: Extension, target: string, selector: string): string[] {
  const { parent, view } = viewWithShortParse(doc, [chanMarkdown(), extension]);
  expect(syntaxTree(view.state).length, "the creation parse stops before the fence or link").toBeLessThan(doc.indexOf(target));
  forceParsing(view, view.state.doc.length, 5000);
  const texts = [...parent.querySelectorAll(selector)].map((el) => el.textContent ?? "");
  view.destroy();
  return texts;
}

test("a tag inside a fence the creation parse stopped before is not a tag once the tree reaches it", () => {
  const doc = "before\n\n```\n#notatag\n```\n\n#realtag";
  const tags = afterForcedParse(doc, tagDecorations({ onTagClick: () => {} }), "```", ".cm-md-tag");
  expect(tags).toEqual(["#realtag"]);
});

test("a mention inside a fence the creation parse stopped before is not a mention once the tree reaches it", () => {
  const doc = "before\n\n```\n@@alice\n```\n\n@@bob";
  const mentions = afterForcedParse(doc, mentionDecorations({ onMentionClick: () => {} }), "```", ".cm-md-mention");
  expect(mentions.some((text) => text.includes("alice")), "the fenced mention").toBe(false);
  expect(mentions.some((text) => text.includes("bob")), "the mention outside the fence").toBe(true);
});

test("a date inside a fence the creation parse stopped before is not a pill once the tree reaches it", () => {
  const doc = "before\n\n```\n2026-08-11\n```\n\n2026-08-12";
  const pills = afterForcedParse(doc, dateDecorations(), "```", ".cm-md-date-pill");
  expect(pills, "only the date outside the fence").toHaveLength(1);
});

test("a wiki link past where the creation parse stopped is a pill once the tree reaches it", () => {
  // The pill draws with its kind still unresolved; the resolve stays open.
  vi.spyOn(api, "resolveLink").mockReturnValue(new Promise(() => {}) as never);
  const doc = "before\n\n[[some note]]";
  const pills = afterForcedParse(
    doc,
    wikiLinkDecorations({ onWikiClick: () => {}, getCurrentPath: () => null }),
    "[[",
    ".cm-md-wiki-pill",
  );
  expect(pills, "the link's pill").toHaveLength(1);
});

test("a code span naming a file past where the creation parse stopped is a link once the tree reaches it", async () => {
  // The kind cache lives as long as the module; the file's kind is resolved
  // first, and its repaint runs before the editor is built.
  const target = "notes/short-parse-real.md";
  vi.useFakeTimers();
  const resolved = Promise.resolve({ path: target, kind: "file" as const, is_dir: false });
  vi.spyOn(api, "resolveLink").mockReturnValue(resolved as never);
  expect(inlineCodeLinkTarget(target, null), "the resolve starts").toBeNull();
  await resolved;
  vi.runAllTimers();
  vi.useRealTimers();
  expect(inlineCodeLinkTarget(target, null), "the file's kind is cached").toBe(target);

  const doc = `before\n\n\`${target}\``;
  const links = afterForcedParse(
    doc,
    inlineCodeLinkDecorations({ onWikiClick: () => {}, getCurrentPath: () => null }),
    "`",
    ".cm-md-code-link",
  );
  expect(links).toEqual([target]);
});
