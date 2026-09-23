import { describe, expect, test } from "vitest";
import { identityPrompt } from "./teamOrchestrator.svelte";

// The lead's identity prompt is now AUTO-DELIVERED to the lead terminal through
// the write queue (the prompt frame), not primed into a Team Work bubble buffer
// (the bubble is gone; the lead is a normal terminal). `identityPrompt` is the
// pure builder for that prompt; these pin its content. The orchestrator's
// delivery of it is exercised in teamBootstrapOrchestrator.test.ts.

describe("identity prompt content", () => {
  const prompt = identityPrompt(
    3,
    "@@Neo",
    "@@Lead",
    ["@@Worker1", "@@Worker2"],
    "/ws",
    "new-team-1",
  );

  test("opens with the Team work header", () => {
    expect(prompt.startsWith("# Team work")).toBe(true);
  });

  test("names the team size, host, and lead", () => {
    expect(prompt).toContain("We are a team of 3");
    expect(prompt).toContain("Our host is @@Neo and the team lead is @@Lead");
  });

  test("lists the worker bullets", () => {
    expect(prompt).toContain("- @@Worker1");
    expect(prompt).toContain("- @@Worker2");
  });

  test("$CHAN_TAB_NAME stays literal (the lead's shell expands it)", () => {
    expect(prompt).toContain("You are $CHAN_TAB_NAME");
    expect(prompt).not.toContain("\\$CHAN_TAB_NAME");
  });

  test("points the lead at the bootstrap doc by its absolute path", () => {
    // bootstrap.md keeps workspace-relative paths (it is a persisted,
    // shareable workspace file), so the poke has to say where it is and
    // what those paths resolve against; a bare `new-team-1/bootstrap.md`
    // gives an agent nothing to anchor on, and the team directory is
    // commonly gitignored so a search for it finds nothing.
    expect(prompt).toContain(
      "Read the team process at /ws/new-team-1/bootstrap.md before you start.",
    );
  });

  test("names the root the document's relative paths resolve against", () => {
    expect(prompt).toContain(
      "Relative paths in that document resolve against /ws.",
    );
  });
});
