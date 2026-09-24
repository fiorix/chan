declare module "*.svelte?raw" {
  const content: string;
  export default content;
}

declare module "*.ts?raw" {
  const content: string;
  export default content;
}

// Minimal `node:fs` shim for tests that need to read on-disk files
// the `?raw` Vite import can't surface (notably `.css`, which the
// CSS plugin chain consumes before vitest sees the file). The full
// `@types/node` package isn't a dev dep; this declaration carries
// just the read helpers we actually call.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

// React is a runtime peer of @excalidraw/excalidraw, dynamic-imported
// only by the one React island (editor/ExcalidrawCanvas.svelte).
// @types/react is not a dev dep; excalidraw carries the React types it
// needs internally, and the island only touches createElement plus the
// createRoot handle, so declare just those two entry-point surfaces.
declare module "react" {
  export function createElement(type: unknown, props?: unknown): unknown;
}

declare module "react-dom/client" {
  export interface Root {
    render(node: unknown): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}
