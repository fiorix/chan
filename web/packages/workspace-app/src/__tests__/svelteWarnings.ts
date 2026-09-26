// The Svelte development build's state-ownership warnings, as a test sees them.
//
// Svelte prints each runtime warning through console.warn, its code after a
// "[svelte] " prefix and its message on the next line. The ownership check is
// compiled into the component that writes a prop, and it fires only when that
// component has a parent, so a test that wants to see it mounts the component
// under the parent the app mounts it under.

import { vi, type MockInstance } from "vitest";

const CODES = new Set(["ownership_invalid_mutation", "ownership_invalid_binding", "assignment_value_stale"]);

/// Start listening, and return a reader of the ownership and stale-assignment
/// warnings printed since, each as "<code>: <message>". The spy calls through,
/// so the warning still prints.
export function ownershipWarnings(): () => string[] {
  const warn: MockInstance<typeof console.warn> = vi.isMockFunction(console.warn)
    ? (console.warn as unknown as MockInstance<typeof console.warn>)
    : vi.spyOn(console, "warn");
  const from = warn.mock.calls.length;
  return () =>
    warn.mock.calls.slice(from).flatMap(([first]: unknown[]) => {
      const [head, message = ""] = String(first).replaceAll("%c", "").replaceAll("\u200b", "").split("\n");
      const code = /^\[svelte\] (\w+)$/.exec(head ?? "")?.[1];
      return code && CODES.has(code) ? [`${code}: ${message}`] : [];
    });
}
