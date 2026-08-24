# A new slide deck does not say how to add a slide

Status: accepted scope for v0.98.0, raised by the owner.

## What was seen

`New slide deck` seeds a file with correct frontmatter and a single `# Slide 1` heading (`NEW_SLIDES_CONTENT` in `crates/chan-server/src/routes/drafts.rs`). The deck opens in the slides layout with the caret at the end of that heading, and nothing on the page says how to get a second slide.

The answer is a page-break line, and in the live editor the way to write one is to type `@pagebreak` on an empty line and commit it with Space or Enter, which rewrites it to `<hr class="chan-page-break">`. That is documented in `chan-shell`'s export help and in `web/packages/workspace-app/EDITOR.md`, neither of which is in front of someone who just created a deck.

## Desired contract

The deck seed carries one bullet under `# Slide 1` telling the author how to make the next slide:

```
* use `@pagebreak` on empty line to create new slide
```

The seed stays a valid one-slide deck that opens in the slides layout, and the caret still lands at the end of `# Slide 1`.

## Why the wording is safe as written

The bullet does not accidentally become a page break. `PAGE_BREAK_RE` (`web/packages/workspace-app/src/editor/slides.ts`) matches only a line that is entirely `<hr class="chan-page-break">` or entirely `@pagebreak`, and this line is neither. The backticks keep the marker as inline code, which is also what stops the `@` from opening the contact bubble when the caret passes it.

Nothing expands the marker in a written file, and that is the point: the seed is teaching the author what to type, not shipping a page break.

## Boundaries

`NEW_SLIDES_CONTENT` and the two tests that pin it (`slides_seed_carries_the_canonical_frontmatter_block` in the same file, and the `firstSlideHeadingCaret` seed mirror in `web/packages/workspace-app/src/editor/slides.test.ts`). The frontmatter block is unchanged, so `parseSlidesSpec` still routes the draft into the slides layout.

The authoring corpus in `crates/chan-shell/src/help.rs` mirrors a deck skeleton for agents. It is a different audience with a different answer (an agent writes the `<hr>` form, because nothing expands `@pagebreak` in a file it wrote), so it does not gain this bullet.

## Acceptance

1. `New slide deck` produces a deck whose body is `# Slide 1` followed by the bullet, and the frontmatter block is byte-identical to today's.
2. The deck opens in the slides layout and renders as one slide, with the bullet as content on it.
3. The caret lands at the end of the `# Slide 1` line, as it does today.
4. Typing `@pagebreak` on an empty line below the bullet and committing with Space or Enter splits the deck into two slides.
5. The seed's page-break line count is zero: the bullet does not register as a page break in `splitSlidePages`, in PDF export, or in present mode.

## Implementation and validation

`NEW_SLIDES_CONTENT` keeps the canonical frontmatter byte-for-byte and adds the instructional bullet immediately after `# Slide 1`. Its Rust test splits the seed at the frontmatter/body boundary and asserts both halves exactly, so metadata drift, wording drift, or an extra blank line fails the test.

The frontend seed mirror asserts that `parseSlidesSpec` still selects the slides layout, `PAGE_BREAK_RE` matches zero seed lines, `splitSlidePages` returns exactly one page containing the bullet, appending a real `@pagebreak` line produces two pages, and `firstSlideHeadingCaret` still lands at the heading end. Present mode and deck PDF export both consume `splitSlidePages`, so the same one-page assertion covers their page count. The focused seed test passes, `slides.test.ts` passes 18/18, `page_break.test.ts` passes 9/9, and `cargo fmt --check` passes after the final Rust edit.
