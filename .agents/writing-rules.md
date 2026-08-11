# Writing Rules

- **No em dashes** in comments or documentation.
- **Tables**: pure ASCII, target 80 columns.
- **Prose: no hard wrap.** Paragraphs, list items, and blockquotes roll as one logical line each; let the editor soft-wrap. Do not reflow prose to 80 columns. Only **tables** target 80 columns (or break the columns into bullets). Commit-message bodies keep their own ~72-column wrap; the `dev/` coordination tree is exempt.
- **Factual**: no marketing language. Include analysis with benchmarks; explain whether numbers meet expectations.
- **Comments**: explain WHY, not WHAT.
- **Snapshot, not changelog**: comments, project docs, and commit subject lines describe the code as it IS, in the present tense (the WHY behind its current shape). Never narrate change over time or cite plan / round / phase numbers or task ids ("§2b", "until §2a splits this out", "previously X, now Y", "TODO round 2"). Change history belongs only in `CHANGELOG.md`, `team/`, and the `dev/` coordination tree (plans, journals, task files); never in code comments, other project docs, or commit headlines. A real runtime phase ("embed phase", "BM25 phase") is fine; this bars PLAN-phase references, including in commit subjects.
