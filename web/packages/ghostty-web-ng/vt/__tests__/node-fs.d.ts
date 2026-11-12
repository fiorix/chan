// The `node:fs` call the tests make to read the vendored wasm off disk.
// `@types/node` is not a dependency of the workspace; this declares the one
// helper they call.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
}
