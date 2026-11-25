import { describe, expect, test } from "vitest";
import {
  DEFAULT_SECRET_MASK_SUFFIXES,
  SecretAssignmentMatcher,
  findSecretMaskSpans,
  type MaskCell,
} from "./secretMasking";

const CORPUS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CACHIX_AUTH_TOKEN",
  "DOCKERHUB_TOKEN",
  "APPLE_PASSWORD",
  "APPLE_CERTIFICATE_PASSWORD",
  "ES_PASSWORD",
  "ES_TOTP_SECRET",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "LAUNCHPAD_GPG_PRIVATE_KEY",
  "LAUNCHPAD_SSH_PRIVATE_KEY",
  "AUR_SSH_PRIVATE_KEY",
  "HOMEBREW_TAP_DEPLOY_KEY_BASE64",
  "POSTGRES_PASSWORD",
];

function values(text: string, matcher = new SecretAssignmentMatcher(DEFAULT_SECRET_MASK_SUFFIXES)) {
  return matcher.find(text).map((range) => text.slice(range.start, range.end));
}

class FakeCell {
  constructor(readonly char: string) {}
  getWidth() {
    return 1;
  }
  getChars() {
    return this.char === " " ? "" : this.char;
  }
}

class FakeLine {
  constructor(
    public text: string,
    readonly cols: number,
    public isWrapped = false,
  ) {}

  get length() {
    return this.cols;
  }

  getCell(x: number): MaskCell | undefined {
    if (x < 0 || x >= this.cols) return undefined;
    return new FakeCell(this.padded()[x] ?? " ");
  }

  translateToString(trimRight = false, start = 0, end = this.cols): string {
    const value = this.padded().slice(start, end);
    return trimRight ? value.trimEnd() : value;
  }

  padded(): string {
    return this.text.padEnd(this.cols, " ").slice(0, this.cols);
  }
}

describe("terminal secret assignment matcher", () => {
  test("masks every workflow-derived stock fixture", () => {
    const matcher = new SecretAssignmentMatcher(DEFAULT_SECRET_MASK_SUFFIXES);
    for (const name of CORPUS) {
      expect(values(`${name}=live-credential`, matcher), name).toEqual([
        "live-credential",
      ]);
    }
  });

  test("is case-insensitive and suffix-anchored without noisy bare-key matches", () => {
    expect(values("api_token=one TOKENIZE=1 MONKEY=2 AUTHOR=alex TLS_CERT=public")).toEqual([
      "one",
    ]);
  });

  test("includes quotes and their spaces while unquoted values stop at whitespace", () => {
    const text = `TOKEN="a b c" NEXT_SECRET=plain trailing`;
    expect(values(text)).toEqual([`"a b c"`, "plain"]);
  });

  test("matches an exact suffix name and adjacent quoted assignments", () => {
    expect(values(`TOKEN=one PASSWORD="two"API_KEY=three`)).toEqual([
      "one",
      `"two"`,
      "three",
    ]);
    expect(values("1TOKEN=not-a-name")).toEqual([]);
  });

  test("rejects regex-shaped client suffixes defensively", () => {
    const matcher = new SecretAssignmentMatcher(["SECRET.*"]);
    expect(matcher.find("MY_SECRET=safe")).toEqual([]);
  });

  test("a rejected digit-led name does not swallow assignments inside its value", () => {
    // The word-boundary rejection applies to the candidate NAME only; it
    // must not consume the quoted text after it, which can itself hold
    // secret-looking assignments.
    expect(values(`1TOKEN="API_KEY=x y"`)).toEqual(["x"]);
    expect(values("1TOKEN=not-a-name")).toEqual([]);
  });

  test("long word runs without assignments scan without pathological backtracking", () => {
    // The matcher is a linear scan: candidate names come from a name-run
    // pass and suffixes are checked in code, so a megabyte-class run of
    // word characters cannot blow up quadratically.
    expect(values("a".repeat(10_000))).toEqual([]);
    expect(values(`${"a".repeat(10_000)} TOKEN=x`)).toEqual(["x"]);
  });

  test("splits a wrapped value across exact row cells", () => {
    const matcher = new SecretAssignmentMatcher(["TOKEN"]);
    const first = new FakeLine("NAME_TOKEN=a", 12);
    const second = new FakeLine("bcdef", 12, true);
    expect(
      findSecretMaskSpans(
        [
          { row: 7, line: first },
          { row: 8, line: second },
        ],
        12,
        matcher,
      ),
    ).toEqual([
      { row: 7, x: 11, width: 1 },
      { row: 8, x: 0, width: 5 },
    ]);
  });
});

describe("a launch URL's token on a loopback host", () => {
  test.each([
    "chan devserver: listening on http://127.0.0.1:18001/?t=tok_a1",
    "http://127.0.0.1:1234/workspace-abcd/index.html?t=tok_a1",
    "http://localhost:8787?t=tok_a1",
    "http://[::1]:18001/?t=tok_a1",
    "http://0.0.0.0:18001/?t=tok_a1",
    "http://[::]:18001/?t=tok_a1",
    "HTTPS://LOCALHOST:18001/?t=tok_a1",
    "http://127.1.2.3:18001/?t=tok_a1",
  ])("masks the t value of %s", (line) => {
    expect(values(line), "the masked values").toEqual(["tok_a1"]);
  });

  test.each([
    "http://localhost:8080/?w=win-1&t=tok_a1&kind=terminal",
    "http://127.0.0.1:18001/?t=tok_a1#top",
    'see "http://127.0.0.1:18001/?t=tok_a1" there',
    "echo 'http://127.0.0.1:18001/?t=tok_a1'",
    "<http://127.0.0.1:18001/?t=tok_a1>",
  ])("ends the value where the parameter ends in %s", (line) => {
    expect(values(line), "the masked values").toEqual(["tok_a1"]);
  });

  // The banner's token and the marker's value beside it are the same secret,
  // so one list decides both.
  test.each<[string, string[], string[]]>([
    ["a suffix of the marker name", ["DEVSERVER_TOKEN"], ["tok_a1"]],
    ["a suffix of another name", ["PASSWORD"], []],
    ["no suffix", [], []],
  ])("with %s listed, the banner's token is masked as the marker's value is", (_list, suffixes, masked) => {
    const matcher = new SecretAssignmentMatcher(suffixes);
    expect(values("CHAN_DEVSERVER_TOKEN=tok_a1", matcher), "the marker's value").toEqual(masked);
    expect(
      values("chan devserver: listening on http://127.0.0.1:18001/?t=tok_a1", matcher),
      "the banner's token",
    ).toEqual(masked);
  });

  test.each([
    "https://www.youtube.com/watch?v=abc&t=42s",
    "https://cdn.example.com/app.js?t=1696000000",
    "http://localhost.example.com/?t=x",
    "http://127.0.0.1.nip.io/?t=x",
    "http://192.168.1.20:18001/?t=x",
    "http://127.0.0.1:18001/?at=x&tt=y&T=z",
    "http://127.0.0.1:18001/#t=x",
    "http://127.0.0.1:18001/#top?t=x",
    "http://127.0.0.1:18001/?t=",
    "?t=x",
    "t=x",
  ])("leaves %s in clear", (line) => {
    expect(values(line), "the masked values").toEqual([]);
  });

  test("a t value and an assignment's value that overlap are one range", () => {
    expect(values("CHAN_URL_TOKEN=http://127.0.0.1:1/?t=abc"), "a URL inside an assignment's value").toEqual([
      "http://127.0.0.1:1/?t=abc",
    ]);
    expect(values("http://127.0.0.1:1/?api_token=a&t=b"), "a t inside an assignment's value").toEqual(["a&t=b"]);
  });
});
