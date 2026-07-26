import type { AgentFetchLike } from "./summarize-content.ts";
import type { ExternalImagesConfig } from "../config/types.ts";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { imageMimeFromBuffer, prepareImageBufferForContext } from "./image-buffer.ts";

export type LinkCacheMode = "prefer" | "refresh" | "bypass";
export type LinkCacheStatus = "hit" | "miss_stored" | "refreshed" | "bypassed";
export type ResolvedLinkKind = "page" | "text" | "image" | "gif" | "audio" | "video";

export interface PageImageReference {
  url: string;
  alt: string;
}

interface ResolvedLinkBase {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  fetchedAt: number;
}

export interface ResolvedPageLink extends ResolvedLinkBase {
  kind: "page";
  title: string;
  readableText: string | null;
  rawText: string | null;
  images: PageImageReference[];
}

export interface ResolvedTextLink extends ResolvedLinkBase {
  kind: "text";
  title: string;
  readableText: string;
  rawText: string;
  images: [];
}

export interface ResolvedImageLink extends ResolvedLinkBase {
  kind: "image" | "gif";
  preview: Buffer;
  previewMimeType: string;
  width: number;
  height: number;
  images: [];
}

export interface ResolvedMediaLink extends ResolvedLinkBase {
  kind: "audio" | "video";
  images: [];
}

export type ResolvedLinkContent = ResolvedPageLink | ResolvedTextLink | ResolvedImageLink | ResolvedMediaLink;

export interface ResolvedLinkResult {
  content: ResolvedLinkContent;
  cacheMode: LinkCacheMode;
  cacheStatus: LinkCacheStatus;
}

export interface LinkContentCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

interface CacheRecord {
  content: ResolvedLinkContent;
  lastAccessedAt: number;
  sizeBytes: number;
}

/** Global bounded cache for fetched link views and coalesced active requests. */
export class LinkContentCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly entries = new Map<string, CacheRecord>();
  private readonly pending = new Map<string, Promise<ResolvedLinkContent>>();
  private totalBytes = 0;

  constructor(options: LinkContentCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 64;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  }

  async resolve(input: {
    url: string;
    cacheMode: LinkCacheMode;
    requireRaw: boolean;
    load: () => Promise<ResolvedLinkContent>;
  }): Promise<ResolvedLinkResult> {
    const key = normalizeCacheKey(input.url);
    const now = Date.now();
    this.pruneExpired(now);
    const cached = this.entries.get(key);
    if (
      input.cacheMode === "prefer"
      && cached !== undefined
      && (!input.requireRaw || hasRawView(cached.content))
    ) {
      cached.lastAccessedAt = now;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { content: cached.content, cacheMode: input.cacheMode, cacheStatus: "hit" };
    }

    const pendingKey = `${input.cacheMode === "refresh" ? "refresh" : "load"}:${input.requireRaw ? "raw" : "readable"}:${key}`;
    let pending = this.pending.get(pendingKey);
    if (pending === undefined) {
      pending = input.load();
      this.pending.set(pendingKey, pending);
    }
    try {
      const content = await pending;
      if (input.cacheMode === "bypass") {
        return { content, cacheMode: input.cacheMode, cacheStatus: "bypassed" };
      }
      this.store(key, content);
      return {
        content,
        cacheMode: input.cacheMode,
        cacheStatus: input.cacheMode === "refresh" ? "refreshed" : "miss_stored",
      };
    } finally {
      if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
    }
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.totalBytes = 0;
  }

  private store(key: string, content: ResolvedLinkContent): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) this.totalBytes -= existing.sizeBytes;
    const record: CacheRecord = {
      content,
      lastAccessedAt: Date.now(),
      sizeBytes: contentSize(content),
    };
    this.entries.delete(key);
    this.entries.set(key, record);
    this.totalBytes += record.sizeBytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].sizeBytes;
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, record] of this.entries) {
      if (now - record.lastAccessedAt <= this.ttlMs) continue;
      this.entries.delete(key);
      this.totalBytes -= record.sizeBytes;
    }
  }
}

export interface LinkContentResolverDeps {
  cache: LinkContentCache;
  externalImages: ExternalImagesConfig;
  fetchFn?: AgentFetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPageImages?: number;
}

/** Resolve one URL through the shared cache, fetching only when the selected mode requires it. */
export async function resolveLinkContent(
  deps: LinkContentResolverDeps,
  input: { url: string; cacheMode?: LinkCacheMode; raw?: boolean },
  signal?: AbortSignal,
): Promise<ResolvedLinkResult> {
  const cacheMode = input.cacheMode ?? "prefer";
  return await deps.cache.resolve({
    url: input.url,
    cacheMode,
    requireRaw: input.raw === true,
    load: async () => await fetchLinkContent(deps, input.url, signal),
  });
}

export function cacheStatusLabel(status: LinkCacheStatus): string {
  if (status === "hit") return "hit";
  if (status === "miss_stored") return "miss; stored";
  if (status === "refreshed") return "refreshed; stored";
  return "bypassed; not stored";
}

function normalizeCacheKey(value: string): string {
  const url = parseHttpUrl(value);
  url.hash = "";
  return url.toString();
}

function hasRawView(content: ResolvedLinkContent): boolean {
  return (content.kind === "page" && content.rawText !== null) || content.kind === "text";
}

function contentSize(content: ResolvedLinkContent): number {
  if (content.kind === "page") {
    return Buffer.byteLength(content.rawText ?? "") + Buffer.byteLength(content.readableText ?? "");
  }
  if (content.kind === "text") return Buffer.byteLength(content.rawText);
  if (content.kind === "image" || content.kind === "gif") return content.preview.length;
  return 512;
}

async function fetchLinkContent(
  deps: LinkContentResolverDeps,
  value: string,
  parentSignal?: AbortSignal,
): Promise<ResolvedLinkContent> {
  const requestedUrl = parseHttpUrl(value).toString();
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const maxResponseBytes = deps.maxResponseBytes ?? 10 * 1024 * 1024;
  const fetchFn = deps.fetchFn ?? fetch;
  const request = createRequestSignal(parentSignal, timeoutMs);
  try {
    try {
      return await fetchDirect({
        requestedUrl,
        fetchFn,
        signal: request.signal,
        maxResponseBytes,
        maxPageImages: deps.maxPageImages ?? deps.externalImages.maxPageImages,
        maxImageBytes: deps.externalImages.maxBytes,
        maxImageDimension: deps.externalImages.maxDimension,
      });
    } catch (directError) {
      if (request.signal.aborted) throw directError;
      try {
        return await fetchJina(requestedUrl, fetchFn, request.signal, maxResponseBytes, deps.maxPageImages ?? deps.externalImages.maxPageImages);
      } catch (jinaError) {
        throw new Error(`direct fetch failed: ${errorMessage(directError)}; Jina reader failed: ${errorMessage(jinaError)}`);
      }
    }
  } finally {
    request.cleanup();
  }
}

async function fetchDirect(input: {
  requestedUrl: string;
  fetchFn: AgentFetchLike;
  signal: AbortSignal;
  maxResponseBytes: number;
  maxPageImages: number;
  maxImageBytes: number;
  maxImageDimension: number;
}): Promise<ResolvedLinkContent> {
  const response = await input.fetchFn(input.requestedUrl, {
    signal: input.signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PersonaBot-PageReader/1.0)",
      Accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml,image/*,audio/*,video/*",
    },
  });
  const finalUrl = response.url !== "" ? response.url : input.requestedUrl;
  const contentType = baseContentType(response.headers.get("content-type"));
  if (!response.ok) {
    if (isTextualContentType(contentType)) {
      const errorBody = (await readLimitedBody(response, Math.min(input.maxResponseBytes, 200_000))).toString("utf8");
      assertNotBotChallenge(errorBody, response.status);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  if (contentType.startsWith("image/")) {
    const buffer = await readLimitedBody(response, input.maxImageBytes);
    return await imageContent(input.requestedUrl, finalUrl, contentType, buffer, input.maxImageDimension);
  }
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
    await response.body?.cancel();
    return {
      kind: contentType.startsWith("audio/") ? "audio" : "video",
      requestedUrl: input.requestedUrl,
      finalUrl,
      contentType,
      fetchedAt: Date.now(),
      images: [],
    };
  }

  const buffer = await readLimitedBody(response, input.maxResponseBytes);
  if (contentType === "" || contentType === "application/octet-stream") {
    const detectedImage = imageMimeFromBuffer(buffer, "");
    if (detectedImage.startsWith("image/")) {
      return await imageContent(input.requestedUrl, finalUrl, detectedImage, buffer, input.maxImageDimension);
    }
  }
  const text = buffer.toString("utf8");
  const htmlLike = isHtmlContentType(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/iu.test(text);
  if (htmlLike) {
    assertNotBotChallenge(text, response.status);
    const page = extractReadablePage(text, finalUrl, input.maxPageImages);
    return {
      kind: "page",
      requestedUrl: input.requestedUrl,
      finalUrl,
      contentType: contentType !== "" ? contentType : "text/html",
      fetchedAt: Date.now(),
      title: page.title,
      readableText: page.readableText,
      rawText: text,
      images: page.images,
    };
  }
  if (!isTextualContentType(contentType) && contentType !== "" && contentType !== "application/octet-stream") {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  if (text.trim() === "") throw new Error("Page returned empty text content");
  return {
    kind: "text",
    requestedUrl: input.requestedUrl,
    finalUrl,
    contentType: contentType !== "" ? contentType : "text/plain",
    fetchedAt: Date.now(),
    title: new URL(finalUrl).hostname,
    readableText: text,
    rawText: text,
    images: [],
  };
}

async function fetchJina(
  requestedUrl: string,
  fetchFn: AgentFetchLike,
  signal: AbortSignal,
  maxResponseBytes: number,
  maxPageImages: number,
): Promise<ResolvedPageLink> {
  const response = await fetchFn(`https://r.jina.ai/${requestedUrl}`, {
    signal,
    headers: { Accept: "text/markdown" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const markdown = (await readLimitedBody(response, maxResponseBytes)).toString("utf8").trim();
  if (markdown === "") throw new Error("Jina reader returned empty content");
  assertNotBotChallenge(markdown, response.status);
  const title = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? new URL(requestedUrl).hostname;
  return {
    kind: "page",
    requestedUrl,
    finalUrl: requestedUrl,
    contentType: "text/markdown",
    fetchedAt: Date.now(),
    title,
    readableText: markdown,
    rawText: null,
    images: extractMarkdownImages(markdown, requestedUrl, maxPageImages),
  };
}

async function imageContent(
  requestedUrl: string,
  finalUrl: string,
  declaredMime: string,
  buffer: Buffer,
  maxDimension: number,
): Promise<ResolvedImageLink> {
  const mimeType = imageMimeFromBuffer(buffer, declaredMime);
  if (!mimeType.startsWith("image/")) throw new Error(`Unsupported decoded image type: ${mimeType}`);
  const prepared = await prepareImageBufferForContext(buffer, mimeType, maxDimension);
  return {
    kind: mimeType === "image/gif" ? "gif" : "image",
    requestedUrl,
    finalUrl,
    contentType: mimeType,
    fetchedAt: Date.now(),
    preview: prepared.data,
    previewMimeType: prepared.mime,
    width: prepared.width,
    height: prepared.height,
    images: [],
  };
}

function extractReadablePage(html: string, url: string, maxPageImages: number): {
  title: string;
  readableText: string | null;
  images: PageImageReference[];
} {
  const { document } = parseHTML(html);
  const images = extractDocumentImages(document, url, maxPageImages);
  const article = new Readability(document).parse();
  const title = article?.title?.trim() !== "" && article?.title !== null && article?.title !== undefined
    ? article.title
    : document.title.trim() !== ""
      ? document.title.trim()
      : new URL(url).hostname;
  if (article === null || article.content === null || article.content === undefined) {
    return { title, readableText: null, images };
  }
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const readableText = turndown.turndown(article.content).trim();
  return { title, readableText: readableText !== "" ? readableText : null, images };
}

function extractDocumentImages(document: Document, pageUrl: string, limit: number): PageImageReference[] {
  const result = new Map<string, PageImageReference>();
  const candidates = [
    document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null,
    ...Array.from(document.querySelectorAll("img")).map((image) =>
      image.getAttribute("data-src")
      ?? image.getAttribute("data-lazy-src")
      ?? image.getAttribute("data-original")
      ?? image.getAttribute("src")
    ),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const normalized = normalizeImageUrl(candidate, pageUrl);
    if (normalized === null || result.has(normalized)) continue;
    const image = Array.from(document.querySelectorAll("img")).find((entry) => {
      const source = entry.getAttribute("data-src") ?? entry.getAttribute("data-lazy-src") ?? entry.getAttribute("data-original") ?? entry.getAttribute("src");
      return source !== null && normalizeImageUrl(source, pageUrl) === normalized;
    });
    result.set(normalized, { url: normalized, alt: image?.getAttribute("alt")?.trim() ?? "" });
    if (result.size >= limit) break;
  }
  return [...result.values()];
}

function extractMarkdownImages(markdown: string, pageUrl: string, limit: number): PageImageReference[] {
  const images = new Map<string, PageImageReference>();
  const pattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const normalized = normalizeImageUrl(match[2] ?? match[3] ?? "", pageUrl);
    if (normalized === null || images.has(normalized)) continue;
    images.set(normalized, { url: normalized, alt: (match[1] ?? "").trim() });
    if (images.size >= limit) break;
  }
  return [...images.values()];
}

function normalizeImageUrl(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function assertNotBotChallenge(text: string, status: number): void {
  const compact = text.slice(0, 120_000).replace(/\s+/gu, " ").trim();
  const structural = /\b(?:cf-chl-|cf-browser-verification|challenge-platform|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com\/turnstile|g-recaptcha|hcaptcha|px-captcha|datadome)\b/iu.test(compact);
  const challengeTitle = /<title[^>]*>\s*(?:just a moment|attention required|access denied)/iu.test(compact);
  const humanCheck = /\b(?:verify you are human|checking (?:if )?your browser|enable javascript and cookies to continue)\b/iu.test(compact);
  if (structural || challengeTitle || ((status === 403 || status === 429 || status === 503) && humanCheck)) {
    throw new Error("anti-bot challenge detected; response was not cached");
  }
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP/HTTPS URLs are supported");
  return url;
}

function baseContentType(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isHtmlContentType(value: string): boolean {
  return value === "text/html" || value === "application/xhtml+xml";
}

function isTextualContentType(value: string): boolean {
  return isHtmlContentType(value)
    || value.startsWith("text/")
    || value === "application/json"
    || value.endsWith("+json")
    || value === "application/xml"
    || value.endsWith("+xml");
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Response exceeds limit ${maxBytes} bytes.`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds limit ${maxBytes} bytes.`);
    }
    chunks.push(value);
    total += value.length;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = (): void => {
    const reason: unknown = parent?.reason;
    controller.abort(reason instanceof Error ? reason : new Error("request aborted"));
  };
  if (parent?.aborted === true) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
