---
name: Feature request
about: Suggest a change or addition to chan
title: ''
labels: enhancement
assignees: ''
---

## Problem / motivation

What user-facing problem are you trying to solve? Concrete use case is more valuable than abstract framing.

## Proposed solution (optional)

A short description of the change you have in mind. Sketches, mockups, or pseudo-code welcome but optional.

## Alternatives considered

If you tried other approaches or thought through alternatives, mention them so reviewers can see the tradeoffs you weighed.

## Fits the chan shape?

chan keeps a tight feature surface. Quick sanity check before opening:

* Does it fit chan's single-binary terminal and workspace model without adding runtime dependencies?
* Does it preserve the chan-workspace facade boundary (no direct filesystem ops on user content outside chan-workspace)?
* Does it stay local-first by default (no required network calls)?

If unsure, that's fine. Open the issue and we'll discuss.
