# Graph inspector language node detail

Status: SHIPPED in [v0.84.0](../../release/release-v0.84.0.md).

- A language node selected in the graph inspector shows only file count and lines of code; it should also carry the COCOMO figures and the top 5 directories holding that language's code, with a load-more for the rest, each rendered as an inspector bubble the user can click to graph from there. chan-report already computes the model and a prefix roll-up carrying totals, by_language, and cocomo (`crates/chan-report/design.md`, `ReportCocomoSummary` in `web/packages/workspace-app/src/api/types.ts`), so the likely shape is surfacing existing data rather than building it.
