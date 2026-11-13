// The Node calls the tests make: reading the vendored wasm and the recorded
// oracle off disk, and the oracle recorder's (record-oracle.ts) write of its
// fixture and its reads of the commit it records from. `@types/node` is not
// a dependency of the workspace; this declares the helpers they call.
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options: { encoding: "utf8" }): string;
}
