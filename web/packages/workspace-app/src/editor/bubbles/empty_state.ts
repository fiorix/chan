import type { IndexStatus } from "../../api/types";

export type BubbleEmptyState =
  | { kind: "empty"; primary: string; secondary?: string }
  | { kind: "indexing"; primary: string; secondary: string }
  | { kind: "none"; primary: string; secondary: string };

export function indexedDocumentCount(status: IndexStatus | null): number {
  if (!status) return 0;
  if (status.state === "idle") return status.indexed_docs;
  if (status.state === "building") return status.current;
  return 0;
}

export function indexInProgress(status: IndexStatus | null): boolean {
  return (
    status?.state === "building" ||
    status?.state === "reindexing" ||
    status?.state === "recovering"
  );
}

export function completionEmptyState(
  query: string,
  indexStatus: IndexStatus | null,
): BubbleEmptyState {
  if (query.trim() === "") {
    return { kind: "empty", primary: "Empty search, type something" };
  }
  const docs = indexedDocumentCount(indexStatus);
  if (indexStatus?.state === "recovering") {
    return {
      kind: "indexing",
      primary: "Rebuilding search index...",
      secondary: "content search is paused until it finishes",
    };
  }
  if (indexInProgress(indexStatus)) {
    return {
      kind: "indexing",
      primary: "Indexing...",
      secondary: `searched ${docs} document${docs === 1 ? "" : "s"} so far`,
    };
  }
  return {
    kind: "none",
    primary: `No matches in ${docs} document${docs === 1 ? "" : "s"}.`,
    secondary: docs === 0 ? "search index is empty" : "",
  };
}

export function renderBubbleEmptyState(
  container: HTMLElement,
  state: BubbleEmptyState,
): void {
  container.innerHTML = "";
  container.classList.add("md-bubble-empty-state");
  const primary = document.createElement("div");
  primary.className = "md-bubble-empty-primary";
  if (state.kind === "indexing") {
    const spinner = document.createElement("span");
    spinner.className = "md-bubble-spinner";
    spinner.setAttribute("aria-hidden", "true");
    primary.appendChild(spinner);
  }
  primary.appendChild(document.createTextNode(state.primary));
  container.appendChild(primary);
  if (state.secondary) {
    const secondary = document.createElement("div");
    secondary.className = "md-bubble-empty-secondary";
    secondary.textContent = state.secondary;
    container.appendChild(secondary);
  }
}
