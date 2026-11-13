// The `node:fs` calls the tests make: reading the vendored wasm, the
// recorded oracle and the package's sources off disk, and listing those
// sources. `@types/node` is not a dependency of the workspace; this
// declares the helpers they call.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string, options: { recursive: true }): string[];
}
