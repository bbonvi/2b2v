import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";
import type { ExternalImagesConfig } from "../config/types.ts";
import { imageMimeFromBuffer, prepareImageBufferForContext } from "../db/image-ingest.ts";
import { readLimitedResponseBody } from "./read-asset-tool.ts";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/tiff"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface LoadedExternalImage {
  sourceUrl: string;
  finalUrl: string;
  kind: "image" | "gif";
  originalMimeType: string;
  preview: Buffer;
  previewMimeType: string;
  width: number;
  height: number;
}

export interface ExternalImageLoaderDeps {
  fetchFn?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

/** Download and decode one public web image, returning a static first-frame preview. */
export async function loadExternalImage(
  sourceUrl: string,
  config: ExternalImagesConfig,
  deps: ExternalImageLoaderDeps = {},
  signal?: AbortSignal,
): Promise<LoadedExternalImage> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const fetchFn = deps.fetchFn ?? fetch;
  const resolveHostname = deps.resolveHostname ?? resolvePublicAddresses;
  let current = parseExternalUrl(sourceUrl);
  let response: Response | undefined;

  for (let redirects = 0; redirects <= config.maxRedirects; redirects++) {
    await assertPublicUrl(current, resolveHostname);
    response = await fetchFn(current, {
      signal: requestSignal,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; 2B-ImageFetcher/1.0)" },
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    if (redirects === config.maxRedirects) throw new Error(`Too many redirects; maximum is ${config.maxRedirects}.`);
    const location = response.headers.get("location");
    if (location === null) throw new Error(`HTTP ${response.status} redirect had no Location header.`);
    current = parseExternalUrl(new URL(location, current).toString());
  }

  if (response === undefined) throw new Error("Image request failed before receiving a response.");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > config.maxBytes) {
    throw new Error(`Image exceeds download limit ${config.maxBytes} bytes.`);
  }
  const declaredMime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_MIMES.has(declaredMime)) throw new Error(`Unsupported content type: ${declaredMime === "" ? "unknown" : declaredMime}`);
  const buffer = await readLimitedResponseBody(response, config.maxBytes);
  const actualMime = imageMimeFromBuffer(buffer, declaredMime);
  if (!IMAGE_MIMES.has(actualMime)) throw new Error(`Unsupported decoded image type: ${actualMime}`);
  const metadata = await sharp(buffer).metadata();
  const processed = await prepareImageBufferForContext(buffer, actualMime, config.maxDimension);
  return {
    sourceUrl,
    finalUrl: current.toString(),
    kind: actualMime === "image/gif" || (metadata.pages ?? 1) > 1 ? "gif" : "image",
    originalMimeType: actualMime,
    preview: processed.data,
    previewMimeType: processed.mime,
    width: processed.width,
    height: processed.height,
  };
}

function parseExternalUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP/HTTPS URLs are supported");
  if (url.username !== "" || url.password !== "") throw new Error("URLs containing credentials are unsupported");
  return url;
}

async function assertPublicUrl(url: URL, resolveHostname: (hostname: string) => Promise<string[]>): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || (!hostname.includes(".") && isIP(hostname) === 0)) {
    throw new Error("Private-network image URLs are unsupported");
  }
  const addresses = isIP(hostname) === 0 ? await resolveHostname(hostname) : [hostname];
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) {
    throw new Error("Private-network image URLs are unsupported");
  }
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
    if (mapped !== null) {
      const high = Number.parseInt(mapped[1] ?? "0", 16);
      const low = Number.parseInt(mapped[2] ?? "0", 16);
      return isPublicIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return isPublicIp(normalized.slice(7));
  }
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0));
  }
  if (isIP(normalized) === 6) {
    return normalized !== "::" && normalized !== "::1"
      && !normalized.startsWith("fc") && !normalized.startsWith("fd")
      && !/^fe[89ab]/u.test(normalized) && !normalized.startsWith("ff")
      && !normalized.startsWith("2001:db8");
  }
  return false;
}
