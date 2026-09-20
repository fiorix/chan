# Export smoke document

#graph-smoke

This document paginates across multiple A4 pages and carries every
render surface the PDF engine must reproduce: styled text, a code
block, a mermaid diagram, an image, and a forced page break.

```js
export function sample() {
  return "code block in the bundled code font";
}
```

```mermaid
flowchart LR
  A[markdown] --> B[paginate]
  B --> C[raster]
  C --> D[pdf]
```

![](photo.png#w=200)

## Section one

Paragraph one of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph two of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph three of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph four of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph five of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph six of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph seven of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph eight of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph nine of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph ten of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

<hr class="chan-page-break">

## Section two, after the forced break

Paragraph eleven of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph twelve of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph thirteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph fourteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph fifteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph sixteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph seventeen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph eighteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph nineteen of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.

Paragraph twenty of the filler stream. The quick brown fox jumps over the lazy dog while the pagination engine measures block rectangles.
