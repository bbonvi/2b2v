import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { AssetIdSchema, parseAssetId } from "./asset-id.ts";
import { formatAssetOrigin, loadAssetTextView, type AssetOrigin, type ReadAssetToolDeps } from "./read-asset-tool.ts";
import { runRipgrep as runRipgrepProcess } from "./ripgrep.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

const SearchAssetParams = Type.Object({
  asset_id: AssetIdSchema,
  pattern: Type.String({ minLength: 1, maxLength: 1000, description: "Ripgrep-compatible regular expression." }),
  context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Lines of context before and after each match." })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum matching lines to return." })),
});

/** Search the textual view of one lazy asset with ripgrep regex syntax. */
export function createSearchAssetTool(deps: ReadAssetToolDeps): AgentTool {
  return markReadOnlyTool({
    name: "search_asset",
    label: "Search Asset",
    description: "Regex-search a text attachment or cached/new audio or video transcript and return line-numbered context.",
    parameters: SearchAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ assetId: number; origin: AssetOrigin; matched: boolean }>> {
      const input = params as { asset_id: unknown; pattern: string; context_lines?: number; max_results?: number };
      const assetId = parseAssetId(input.asset_id);
      if (assetId === null) throw new Error("asset_id must be a positive integer, optionally prefixed with #");
      const asset = deps.getAsset(assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      if (asset.kind !== "text" && asset.kind !== "audio" && asset.kind !== "video") {
        throw new Error(`Asset #${assetId} is not text-searchable.`);
      }
      const origin = await deps.resolveOrigin(asset);
      if (origin === null) throw new Error(`Asset ${assetId} source channel is unavailable or inaccessible.`);
      const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds[asset.kind] * 1000);
      const searchSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const source = await deps.resolveSource(asset);
      searchSignal.throwIfAborted();
      const cachedTranscriptAvailable = (asset.kind === "audio" || asset.kind === "video") && asset.extractedText !== null;
      if (source === null && !cachedTranscriptAvailable) throw new Error(`Asset ${assetId} source is no longer available.`);
      const effectiveSource = source ?? { url: "", filename: asset.filename, contentType: asset.contentType };
      const view = await loadAssetTextView(deps, asset, effectiveSource, searchSignal);
      const maxResults = input.max_results ?? 10;
      const contextLines = input.context_lines ?? 2;
      const result = await runRipgrep(view.text, input.pattern, contextLines, maxResults, deps.config.maxCharsPerRead, searchSignal);
      const filename = effectiveSource.filename ?? asset.filename;
      const heading = `Asset: ${asset.kind === "text" ? "Text" : "Transcript"} #${asset.id}${filename !== null ? ` — ${filename}` : ""}\n${formatAssetOrigin(origin)}\nRegex: ${JSON.stringify(input.pattern)}`;
      return {
        content: [{ type: "text", text: result === null
          ? `${heading}\nNo matches.`
          : `${heading}\nShowing up to ${maxResults} matching lines with ${contextLines} context lines:\n${result}` }],
        details: { assetId: asset.id, origin, matched: result !== null },
      };
    },
  });
}

async function runRipgrep(
  text: string,
  pattern: string,
  contextLines: number,
  maxResults: number,
  maxChars: number,
  signal: AbortSignal,
): Promise<string | null> {
  const stdout = await runRipgrepProcess([
    "--line-number",
    "--text",
    "--no-filename",
    "--no-heading",
    "--color=never",
    `--context=${contextLines}`,
    `--max-count=${maxResults}`,
    "--max-columns=2000",
    "--max-columns-preview",
    "--regexp",
    pattern,
  ], text, signal);
  if (stdout === null) return null;
  const clean = stdout.trim();
  if (clean.length <= maxChars) return clean;
  const cutoff = clean.lastIndexOf("\n", maxChars);
  return `${clean.slice(0, cutoff > 0 ? cutoff : maxChars)}\n[Search output truncated; narrow the regex.]`;
}
