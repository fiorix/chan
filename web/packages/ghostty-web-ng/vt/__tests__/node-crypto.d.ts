// The `node:crypto` calls the vendored core's test makes to hash the core
// and check its minisign signature. `@types/node` is not a dependency of
// the workspace; this declares the helpers it calls.
declare module "node:crypto" {
  export interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Uint8Array;
    digest(encoding: "hex"): string;
  }
  export interface KeyObject {
    readonly type: string;
  }
  export function createHash(algorithm: "sha256" | "blake2b512"): Hash;
  export function createPublicKey(key: { key: Uint8Array; format: "der"; type: "spki" }): KeyObject;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
}
