import { describe, expect, test } from "bun:test";
import { DEFAULT_EXTERNAL_IMAGES } from "../config/defaults.ts";
import { loadExternalImage } from "./external-image.ts";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const publicDns = () => Promise.resolve(["93.184.216.34"]);

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("Expected rejection");
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

describe("loadExternalImage", () => {
  test("converts GIF references to a static first-frame preview", async () => {
    const image = await loadExternalImage("https://example.com/a.gif", DEFAULT_EXTERNAL_IMAGES, {
      resolveHostname: publicDns,
      fetchFn: () => Promise.resolve(new Response(GIF, { headers: { "content-type": "image/gif" } })),
    });
    expect(image.kind).toBe("gif");
    expect(image.originalMimeType).toBe("image/gif");
    expect(image.previewMimeType).toBe("image/jpeg");
  });

  test("blocks literal and DNS-resolved private network targets", async () => {
    expect(await rejectionMessage(loadExternalImage("http://127.0.0.1/a.png", DEFAULT_EXTERNAL_IMAGES))).toContain("Private-network");
    expect(await rejectionMessage(loadExternalImage("https://example.com/a.png", DEFAULT_EXTERNAL_IMAGES, {
      resolveHostname: () => Promise.resolve(["10.0.0.1"]),
    }))).toContain("Private-network");
    expect(await rejectionMessage(loadExternalImage("http://[::ffff:127.0.0.1]/a.png", DEFAULT_EXTERNAL_IMAGES))).toContain("Private-network");
  });

  test("revalidates redirect destinations", async () => {
    let fetched = 0;
    expect(await rejectionMessage(loadExternalImage("https://public.example/a.png", DEFAULT_EXTERNAL_IMAGES, {
      resolveHostname: (hostname) => Promise.resolve([hostname === "private.example" ? "192.168.1.2" : "93.184.216.34"]),
      fetchFn: () => {
        fetched++;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://private.example/a.png" } }));
      },
    }))).toContain("Private-network");
    expect(fetched).toBe(1);
  });

  test("rejects declared bodies above the byte limit", async () => {
    expect(await rejectionMessage(loadExternalImage("https://example.com/a.png", { ...DEFAULT_EXTERNAL_IMAGES, maxBytes: 10 }, {
      resolveHostname: publicDns,
      fetchFn: () => Promise.resolve(new Response(GIF, {
        headers: { "content-type": "image/gif", "content-length": "100" },
      })),
    }))).toContain("download limit");
  });
});
