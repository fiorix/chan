---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Wide image

Ordinary text, **bold text** and `inline code` expose the selected theme. Both coloured end caps and the white centre line belong to the image.

![Wide image with left and right edge markers](wide.svg)

<hr class="chan-page-break">

# Mermaid diagram

```mermaid
flowchart LR
  source[Source slide] --> layout[Virtual page]
  layout --> export[PDF page]
```

<hr class="chan-page-break">

# Excalidraw diagram

The scene's blue rectangle and overlapping red ellipse should both be visible.

![Excalidraw drawing](board.excalidraw#w=420)

<hr class="chan-page-break">

# Tall image

The source image's orange foot marks its lower edge. The complete slide may scale to fit its virtual page.

![Tall image with orange foot](tall.png#w=250)

<hr class="chan-page-break">

<div style="position:relative;height:700px"><h1>Image near the lower edge</h1><p>The boundary image starts 440 pixels below the slide content's top and ends at 700 pixels. All four coloured bands and the white centre stripe belong to this slide.</p><img alt="Boundary image" src="boundary.svg" style="position:absolute;top:440px;left:20px;width:520px;height:260px;max-width:none;margin:0"></div>

<hr class="chan-page-break">

# Diagram near the lower edge

The space above the Mermaid diagram places it near the virtual page's lower edge before fitting.

<div style="height:280px"></div>

```mermaid
flowchart TD
  first[Lower-edge diagram start] --> second[Keep the connecting arrow]
  second --> third[Lower-edge diagram end]
```
