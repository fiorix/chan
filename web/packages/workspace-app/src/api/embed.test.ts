import { describe, expect, test } from "vitest";
import {
  detectEmbed,
  embedDimensions,
  embedFromSrc,
  embedIframeHtml,
  isAllowedEmbedSrc,
} from "./embed";

describe("detectEmbed: YouTube", () => {
  test("youtu.be short link", () => {
    const e = detectEmbed("https://youtu.be/dQw4w9WgXcQ");
    expect(e).toEqual({
      kind: "youtube",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      title: "YouTube video",
    });
  });

  test("watch?v= link", () => {
    const e = detectEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42");
    expect(e?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  test("/embed/, /shorts/, /live/ paths", () => {
    for (const path of ["embed", "shorts", "live"]) {
      const e = detectEmbed(`https://www.youtube.com/${path}/dQw4w9WgXcQ`);
      expect(e?.src).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      );
    }
  });

  test("rejects a malformed video id", () => {
    expect(detectEmbed("https://youtu.be/not-an-id")).toBeNull();
    expect(detectEmbed("https://www.youtube.com/watch?v=short")).toBeNull();
  });
});

describe("detectEmbed: Google Maps", () => {
  test("keyless share-embed (pb) form passes through", () => {
    const e = detectEmbed(
      "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3",
    );
    expect(e?.kind).toBe("maps");
    expect(e?.src).toContain("https://www.google.com/maps/embed?pb=");
  });

  test("a share-embed on another Google host lands on the host the frame allowlist admits", () => {
    for (const host of ["maps.google.com", "google.com"]) {
      const e = detectEmbed(`https://${host}/maps/embed?pb=!1m18!1m12!1m3`);
      expect(e?.src, host).toBe("https://www.google.com/maps/embed?pb=!1m18!1m12!1m3");
      expect(isAllowedEmbedSrc(e?.src), host).toBe(true);
    }
  });

  test("a place/search link becomes the output=embed form", () => {
    const e = detectEmbed(
      "https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z",
    );
    expect(e?.kind).toBe("maps");
    expect(e?.src).toBe(
      "https://www.google.com/maps?q=48.8584,2.2945&output=embed",
    );
  });

  test("a ?q= link becomes the output=embed form", () => {
    const e = detectEmbed("https://maps.google.com/maps?q=Big+Ben");
    expect(e?.src).toBe(
      "https://www.google.com/maps?q=Big%20Ben&output=embed",
    );
  });

  test("a non-maps google path is not an embed", () => {
    expect(detectEmbed("https://www.google.com/search?q=cats")).toBeNull();
  });
});

describe("detectEmbed: negatives", () => {
  test("plain image and arbitrary hosts are not embeds", () => {
    expect(detectEmbed("https://example.com/cat.png")).toBeNull();
    expect(detectEmbed("./local.png")).toBeNull();
    expect(detectEmbed("not a url")).toBeNull();
    expect(detectEmbed("")).toBeNull();
  });
});

describe("isAllowedEmbedSrc", () => {
  test("only https on the allowlisted hosts", () => {
    expect(
      isAllowedEmbedSrc("https://www.youtube-nocookie.com/embed/x"),
    ).toBe(true);
    expect(isAllowedEmbedSrc("https://www.google.com/maps/embed?pb=x")).toBe(
      true,
    );
    // wrong host, wrong scheme, or junk
    expect(isAllowedEmbedSrc("https://evil.com/embed/x")).toBe(false);
    expect(
      isAllowedEmbedSrc("http://www.youtube-nocookie.com/embed/x"),
    ).toBe(false);
    expect(isAllowedEmbedSrc("javascript:alert(1)")).toBe(false);
    expect(isAllowedEmbedSrc(null)).toBe(false);
  });
});

describe("embedDimensions / width hint", () => {
  test("youtube keeps 16:9", () => {
    expect(embedDimensions("youtube", 320)).toEqual({ width: 320, height: 180 });
  });
  test("default width when no hint", () => {
    expect(embedDimensions("youtube", null).width).toBe(560);
  });
  test("embedFromSrc honors #w=", () => {
    const r = embedFromSrc("https://youtu.be/dQw4w9WgXcQ#w=400");
    expect(r?.width).toBe(400);
    expect(r?.height).toBe(225);
  });
});

describe("embedIframeHtml", () => {
  test("builds a sandboxed iframe for an embeddable url", () => {
    const html = embedIframeHtml("https://youtu.be/dQw4w9WgXcQ");
    expect(html).toContain("<iframe");
    expect(html).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(html).toContain("sandbox=");
    expect(html).toContain("allowfullscreen");
  });

  test("returns null for a non-embed url", () => {
    expect(embedIframeHtml("https://example.com/cat.png")).toBeNull();
  });
});
