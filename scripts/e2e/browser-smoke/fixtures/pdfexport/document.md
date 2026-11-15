# Export reading: document

Ordinary text, **bold text**, *italic text* and `inline code` establish the document's foreground and background. The images retain their authored colours; Mermaid and Excalidraw use the selected editor theme.

## Wide image

The complete wide image has a violet left cap, a green middle, an amber right cap and a white centre line. Its native size is 1800 by 240 pixels.

![Wide image with left and right edge markers](wide.svg)

## Mermaid in normal flow

```mermaid
flowchart LR
  source[Source document] --> layout[Paginated layout]
  layout --> export[Raster PDF]
```

<hr class="chan-page-break">

# Tall image

The blue image has an orange foot. Its requested width is 600 pixels, giving a height of 1200 pixels before pagination; both the blue body and orange foot belong to one source image.

![Tall image with orange foot](tall.png#w=600)

Text after the tall image identifies the end of this section.

<hr class="chan-page-break">

<div style="position:relative;height:1250px"><h1>Image across a page boundary</h1><p>The image starts 850 pixels into this 1250 pixel block. Its rose top and bottom borders, teal upper half, blue lower half and white centre stripe identify the parts on either side of a cut.</p><img alt="Boundary image" src="boundary.svg" style="position:absolute;top:850px;left:20px;width:520px;height:260px;max-width:none;margin:0"></div>

<hr class="chan-page-break">

# Mermaid near a page boundary

This fixed space puts the following diagram near the end of the printable page. The export can move the whole diagram; the resulting gap and page position are part of the reading.

<div style="height:710px"></div>

```mermaid
flowchart TD
  first[Boundary diagram start] --> second[Keep the connecting arrow]
  second --> third[Boundary diagram end]
```

Text after the Mermaid diagram identifies the complete lower edge.

<hr class="chan-page-break">

# Excalidraw near a page boundary

This real Excalidraw scene holds a blue rounded rectangle and an overlapping red ellipse. The space before it puts the drawing near the printable page edge.

<div style="height:710px"></div>

![Excalidraw boundary drawing](board.excalidraw#w=420)

Text after the Excalidraw drawing identifies the complete lower edge.
