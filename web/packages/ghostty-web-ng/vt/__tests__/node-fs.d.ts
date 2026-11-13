// The `node:fs` calls the tests make to read the vendored wasm and the
// recorded oracle off disk. `@types/node` is not a dependency of the
// workspace; this declares the helpers they call.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
