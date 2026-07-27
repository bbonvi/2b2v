import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { AssetIdSchema, parseAssetId } from "./asset-id.ts";
import { formatAssetOrigin, isPdfAsset, loadAssetTextView, type AssetOrigin, type ReadAssetToolDeps } from "./read-asset-tool.ts";
import { markReadOnlyTool } from "./tool-effects.ts";
import { searchTextView } from "./text-view.ts";
import { cacheStatusLabel, type LinkCacheMode } from "./link-content.ts";

const LinkCacheModeSchema = Type.Union([
  Type.Literal("prefer"),
  Type.Literal("refresh"),
  Type.Literal("bypass"),
], {
  description: "prefer reuses available content; refresh fetches and saves a new copy; bypass fetches without saving.",
});

const SearchAssetParams = Type.Object({
  asset_id: AssetIdSchema,
  pattern: Type.String({ minLength: 1, maxLength: 1000 }),
  context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  raw: Type.Optional(Type.Boolean({ description: "Use source markup instead of readable content." })),
  cache_mode: Type.Optional(LinkCacheModeSchema),
});

/** Search the textual view of one lazy asset with ripgrep regex syntax. */
export function createSearchAssetTool(deps: ReadAssetToolDeps): AgentTool {
  return markReadOnlyTool({
    name: "search_asset",
    label: "Search Asset",
    description: "",
    parameters: SearchAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{
      assetId: number;
      origin: AssetOrigin;
      matched: boolean;
      resolvedKind?: string;
      cacheMode?: LinkCacheMode;
      cacheStatus?: string;
      raw?: boolean;
    }>> {
      const input = params as {
        asset_id: unknown;
        pattern: string;
        context_lines?: number;
        max_results?: number;
        raw?: boolean;
        cache_mode?: LinkCacheMode;
      };
      const assetId = parseAssetId(input.asset_id);
      if (assetId === null) throw new Error("asset_id must be a positive integer, optionally prefixed with #");
      const asset = deps.getAsset(assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      if (asset.kind !== "text" && asset.kind !== "audio" && asset.kind !== "video" && asset.kind !== "link" && !isPdfAsset(asset)) {
        throw new Error(`Asset #${assetId} is not text-searchable.`);
      }
      if (asset.kind !== "link" && (input.raw !== undefined || input.cache_mode !== undefined)) {
        throw new Error("raw and cache_mode apply only to Link assets.");
      }
      const origin = await deps.resolveOrigin(asset);
      if (origin === null) throw new Error(`Asset ${assetId} source channel is unavailable or inaccessible.`);
      const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds[asset.kind] * 1000);
      const searchSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const source = await deps.resolveSource(asset);
      searchSignal.throwIfAborted();
      const cachedTextAvailable = asset.extractedText !== null
        && (asset.kind === "audio" || asset.kind === "video" || isPdfAsset(asset));
      if (source === null && !cachedTextAvailable) throw new Error(`Asset ${assetId} source is no longer available.`);
      const effectiveSource = source ?? { url: "", filename: asset.filename, contentType: asset.contentType };
      const maxResults = input.max_results ?? 10;
      const contextLines = input.context_lines ?? 2;
      if (asset.kind === "link") {
        if (source === null) throw new Error(`Link asset ${assetId} source is no longer available.`);
        if (deps.resolveLink === undefined) throw new Error("Link searching is unavailable.");
        const resolved = await deps.resolveLink({
          url: source.url,
          cacheMode: input.cache_mode,
          raw: input.raw,
        }, searchSignal);
        if (resolved.content.kind !== "page" && resolved.content.kind !== "text") {
          throw new Error(`Link asset #${assetId} resolved to ${resolved.content.kind}, which is not text-searchable.`);
        }
        const text = input.raw === true ? resolved.content.rawText : resolved.content.readableText;
        if (text === null) {
          throw new Error(input.raw === true
            ? "Raw source is unavailable for this fetched page."
            : "Readable extraction failed. Retry with raw=true to search source markup.");
        }
        const result = await searchTextView(text, input.pattern, contextLines, maxResults, deps.config.maxCharsPerRead, searchSignal);
        const heading = [
          `Asset: Link #${asset.id}`,
          formatAssetOrigin(origin),
          `Link: ${resolved.content.requestedUrl}`,
          `Resolved: ${resolved.content.kind} (${resolved.content.contentType})`,
          `Cache: ${cacheStatusLabel(resolved.cacheStatus)}`,
          `View: ${input.raw === true ? "raw" : "readable"}`,
          `Regex: ${JSON.stringify(input.pattern)}`,
        ].join("\n");
        return {
          content: [{ type: "text", text: result === null
            ? `${heading}\nNo matches.`
            : `${heading}\nShowing up to ${maxResults} matches with ${contextLines} context lines:\n${result}` }],
          details: {
            assetId: asset.id,
            origin,
            matched: result !== null,
            resolvedKind: resolved.content.kind,
            cacheMode: resolved.cacheMode,
            cacheStatus: resolved.cacheStatus,
            raw: input.raw === true,
          },
        };
      }
      const view = await loadAssetTextView(deps, asset, effectiveSource, searchSignal);
      const result = await searchTextView(view.text, input.pattern, contextLines, maxResults, deps.config.maxCharsPerRead, searchSignal);
      const filename = effectiveSource.filename ?? asset.filename;
      const heading = `Asset: ${asset.kind === "text" || isPdfAsset(asset, effectiveSource) ? "Text" : "Transcript"} #${asset.id}${filename !== null ? ` — ${filename}` : ""}\n${formatAssetOrigin(origin)}\nRegex: ${JSON.stringify(input.pattern)}`;
      return {
        content: [{ type: "text", text: result === null
          ? `${heading}\nNo matches.`
          : `${heading}\nShowing up to ${maxResults} matching lines with ${contextLines} context lines:\n${result}` }],
        details: { assetId: asset.id, origin, matched: result !== null },
      };
    },
  });
}
