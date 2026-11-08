import { describe, expect, test } from "vitest";
import { tunnelCommand } from "./tunnelCommand";

describe("the devserver command", () => {
  test("uses the gateway endpoint and keeps the token in the environment", () => {
    const command = tunnelCommand("https://proxy.example.test/v1/tunnel");
    expect(command).toBe("export CHAN_TUNNEL_TOKEN=<token>\nchan devserver start --tunnel-url https://proxy.example.test/v1/tunnel");
    expect(command).not.toContain("--tunnel-token");
  });

  test.each([undefined, null, ""])("shows an explicit placeholder without a URL (%s)", (url) => {
    const command = tunnelCommand(url);
    expect(command).toBe("export CHAN_TUNNEL_TOKEN=<token>\nchan devserver start --tunnel-url <this gateway's tunnel URL>");
    expect(command).not.toContain("--tunnel-token");
  });

  test("quotes shell metacharacters in a supplied URL", () => {
    expect(tunnelCommand("https://proxy.example.test/v1/tunnel?node=a&region=b")).toBe(
      "export CHAN_TUNNEL_TOKEN=<token>\nchan devserver start --tunnel-url 'https://proxy.example.test/v1/tunnel?node=a&region=b'",
    );
    expect(tunnelCommand("https://proxy.example.test/a'b")).toContain("'https://proxy.example.test/a'\\''b'");
  });
});
