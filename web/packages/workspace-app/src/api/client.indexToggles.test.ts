import { describe, expect, test } from "vitest";
import client from "./client.ts?raw";

describe("reports client methods", () => {
  test("api.reportsState hits GET /api/index/reports/state", () => {
    expect(client).toMatch(
      /reportsState: \(\) =>[\s\S]*?req<\{ enabled: boolean \}>\("GET", "\/api\/index\/reports\/state"\)/,
    );
  });

  test("api.reportsEnable hits POST /api/index/reports/enable", () => {
    expect(client).toMatch(
      /reportsEnable: \(\) =>[\s\S]*?req<\{ enabled: boolean \}>\("POST", "\/api\/index\/reports\/enable"\)/,
    );
  });

  test("api.reportsDisable hits POST /api/index/reports/disable", () => {
    expect(client).toMatch(
      /reportsDisable: \(\) =>[\s\S]*?req<\{ enabled: boolean \}>\("POST", "\/api\/index\/reports\/disable"\)/,
    );
  });

  test("doc comment references the reports route and indexing-pass trigger", () => {
    expect(client).toMatch(/Per-workspace chan-reports toggle/);
    expect(client).toMatch(/reports_toggle\.rs/);
    expect(client).toMatch(/incremental indexing pass/i);
  });

  test("shape mirrors the semantic-toggle methods", () => {
    // Both reports + semantic ship the same 3-method shape:
    // state (GET) + enable (POST) + disable (POST). This pin
    // anchors the parallel so a future audit can see they're
    // siblings.
    expect(client).toMatch(/semanticState: \(\) =>/);
    expect(client).toMatch(/reportsState: \(\) =>/);
  });
});
