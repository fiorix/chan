declare module "*.svelte?raw" {
  const content: string;
  export default content;
}

declare module "*.ts?raw" {
  const content: string;
  export default content;
}

// Minimal `node:fs` shim for a test that reads an on-disk file the `?raw`
// Vite import cannot surface (notably `.css`, which the CSS plugin chain
// consumes before vitest sees it). `@types/node` is not a dev dep; this
// declaration carries just the read helper that test calls.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
