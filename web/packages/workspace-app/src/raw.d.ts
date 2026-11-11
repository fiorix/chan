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
// CSS plugin chain consumes before vitest sees the file), and for the
// measurements that write their figures out. The full `@types/node`
// package isn't a dev dep; this declaration carries just the helpers
// we actually call.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
  export function writeFileSync(path: string, data: string): void;
}

// The `node:process` members a measurement reads: its settings from the
// environment, the Node version for its report, and the monotonic clock.
declare module "node:process" {
  export const env: Record<string, string | undefined>;
  export const version: string;
  export const hrtime: { bigint(): bigint };
}

// React is a runtime peer of @excalidraw/excalidraw, dynamic-imported
// only by the one React island (editor/ExcalidrawCanvas.svelte).
// @types/react is not a dev dep; excalidraw carries the React types it
// needs internally. Declare just the island's entry-point surfaces.
declare module "react" {
  export class Component<P = unknown, S = unknown> {
    constructor(props: P);
    readonly props: Readonly<P>;
    state: S;
    render(): unknown;
  }
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
}

declare module "react-dom/client" {
  export interface Root {
    render(node: unknown): void;
    unmount(): void;
  }
  export function createRoot(container: Element): Root;
}
