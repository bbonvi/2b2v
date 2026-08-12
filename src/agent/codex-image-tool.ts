import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { getCodexApiKey } from "../llm/codex-auth.ts";
import type { Logger } from "../logger.ts";
import type { EnqueueImageJobResult, ImageReference } from "./job-runtime.ts";
import type { ImageGenerationQuality } from "../config/types.ts";
import { renderPromptTemplate, type PromptTemplateVariables } from "../config/prompt-template.ts";
import { imageExtensionForMime, imageMimeFromBuffer } from "./image-buffer.ts";
import { AssetRefSchema, parseAssetRef, type AssetRef } from "./asset-id.ts";
import {
  BACKEND_IMAGE_MODEL,
  codexFailureMessage,
  codexImageFailureMessageForAgent,
  extractChatGptAccountId,
  isRecord,
  mimeForFormat,
  requestImage,
  type ImageTransport,
  type OutputFormat,
} from "./codex-image-client.ts";
import { imageSizeFromBuffer } from "./codex-image-size.ts";

const DEFAULT_OUTPUT_FORMAT = "webp";

const CodexGenerateImageParams = Type.Object({
  prompt: Type.String(),
  reference_images: Type.Optional(Type.Array(Type.Union([
    Type.Object({
      type: Type.Literal("asset"),
      asset_id: AssetRefSchema,
    }, { additionalProperties: false }),
    Type.Object({
      type: Type.Literal("url"),
      url: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    Type.Object({
      type: Type.Literal("avatar"),
      user_id: Type.String({ pattern: "^[0-9]{17,20}$" }),
    }, { additionalProperties: false }),
  ]))),
  output_format: Type.Optional(Type.Union([
    Type.Literal("png"),
    Type.Literal("jpeg"),
    Type.Literal("webp"),
  ])),
  "4k": Type.Optional(Type.Boolean()),
  replaces_job_id: Type.Optional(Type.String()),
});

export interface GeneratedImageAttachment {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  prompt: string;
  revisedPrompt?: string;
  requestedSize?: string;
  actualSize?: string;
  transport?: ImageTransport;
  is4k?: boolean;
}

export interface ReferenceImageInput {
  id: number | string;
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface CodexGenerateImageToolDeps {
  codexAuthPath: string;
  model: string;
  sessionId?: string;
  enableDirectImageFallback?: boolean;
  fetchFn?: typeof fetch;
  logger?: Logger;
  imageReferenceMaxPerCall: number;
  imageGenerationQuality: ImageGenerationQuality;
  resolveReferenceImage?: (id: AssetRef) => Promise<ReferenceImageInput | null>;
  resolveExternalReference?: (url: string, signal?: AbortSignal) => Promise<ReferenceImageInput>;
  resolveAvatarReference?: (userId: string, signal?: AbortSignal) => Promise<ReferenceImageInput | null>;
  onGeneratedImage: (attachment: GeneratedImageAttachment) => void;
  /** Persist a synchronous result for explicit delivery instead of queuing it on the next message. */
  stageGeneratedImage?: (attachment: GeneratedImageAttachment) => Promise<{
    assetRef: string;
    workspacePath: string;
  }>;
  /** Tool-result template used when an async image job request is not accepted. */
  asyncJobAlreadyActiveTemplate?: string;
  /** Tool-result template used after a new async image job is queued. */
  asyncJobStartedTemplate?: string;
  enqueueImageJob?: (input: {
    prompt: string;
    references: ImageReference[];
    outputFormat: OutputFormat;
    is4k: boolean;
    replacesJobId?: string;
  }) => EnqueueImageJobResult;
}

type CodexGenerateImageDetails =
  | ({
    provider: "openai-codex";
    model: string;
    backendImageModel: "gpt-image-2";
    outputFormat: OutputFormat;
    is4k: boolean;
    references: ImageReference[];
    responseId?: string;
    imageGenerationId?: string;
    revisedPrompt?: string;
    transport: ImageTransport;
    requestedSize?: string;
    actualSize?: string;
    usage?: unknown;
  } & (
    | { generatedAttachmentIds: string[] }
    | { stagedAssetRef: string; workspacePath: string }
  ))
  | {
    asyncJobId: string;
    asyncJobStatus: string;
    asyncJobCreated: boolean;
    is4k: boolean;
    reason?: string;
    assetHistory?: number[];
  };

function outputFormat(value: unknown): OutputFormat {
  return value === "jpeg" || value === "webp" || value === "png" ? value : DEFAULT_OUTPUT_FORMAT;
}

function parseImageReferences(value: unknown): ImageReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("reference_images must be an array.");
  const references: ImageReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") {
      throw new Error("Each reference_images entry must have a supported type.");
    }
    let reference: ImageReference;
    if (item.type === "asset") {
      const assetId = parseAssetRef(item.asset_id);
      if (assetId === null) throw new Error("Asset references require a permanent asset ID or staged handle.");
      reference = { type: "asset", assetId };
    } else if (item.type === "url") {
      if (typeof item.url !== "string") throw new Error("URL references require a URL string.");
      let url: URL;
      try { url = new URL(item.url); } catch { throw new Error(`Invalid reference URL: ${item.url}`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL references support only HTTP/HTTPS URLs.");
      reference = { type: "url", url: url.toString() };
    } else if (item.type === "avatar") {
      if (typeof item.user_id !== "string" || !/^\d{17,20}$/u.test(item.user_id)) {
        throw new Error("Avatar references require a Discord user_id.");
      }
      reference = { type: "avatar", userId: item.user_id };
    } else {
      throw new Error(`Unsupported image reference type: ${item.type}`);
    }
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

async function loadReferenceImages(
  deps: CodexGenerateImageToolDeps,
  references: ImageReference[],
  signal?: AbortSignal,
): Promise<ReferenceImageInput[]> {
  if (references.length > deps.imageReferenceMaxPerCall) {
    throw new Error(`Too many reference images requested (${references.length}); maximum is ${deps.imageReferenceMaxPerCall} per call.`);
  }

  const images: ReferenceImageInput[] = [];
  for (const reference of references) {
    if (reference.type === "asset") {
      if (deps.resolveReferenceImage === undefined) throw new Error("Chat asset references are unavailable.");
      const resolved = await deps.resolveReferenceImage(reference.assetId);
      if (resolved === null) throw new Error(`Reference asset ${reference.assetId} was not found or is not visual.`);
      images.push(resolved);
      continue;
    }
    if (reference.type === "url") {
      if (deps.resolveExternalReference === undefined) throw new Error("External image references are unavailable.");
      images.push(await deps.resolveExternalReference(reference.url, signal));
      continue;
    }
    if (deps.resolveAvatarReference === undefined) throw new Error("Avatar references are unavailable.");
    const resolved = await deps.resolveAvatarReference(reference.userId, signal);
    if (resolved === null) throw new Error(`Avatar reference for user ${reference.userId} is no longer available in this guild.`);
    images.push(resolved);
  }
  return images;
}

function renderOptionalPromptTemplate(
  template: string | undefined,
  variables: PromptTemplateVariables,
  fallback: string,
): string {
  const trimmed = template?.trim();
  return trimmed !== undefined && trimmed !== "" ? renderPromptTemplate(trimmed, variables) : fallback;
}

/** Create a tool that generates images through Codex subscription image_generation. */
export function createCodexGenerateImageTool(deps: CodexGenerateImageToolDeps): AgentTool {
  return {
    name: "codex_generate_image",
    label: "Codex Image",
    description: "",
    parameters: CodexGenerateImageParams,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<CodexGenerateImageDetails>> {
      const p = params as {
        prompt: string;
        output_format?: unknown;
        "4k"?: unknown;
        reference_images?: unknown;
        replaces_job_id?: unknown;
      };
      const prompt = p.prompt.trim();
      if (prompt === "") throw new Error("Image prompt must not be empty.");
      const output = outputFormat(p.output_format);
      const is4k = p["4k"] === true;
      const references = parseImageReferences(p.reference_images);
      if (references.length > deps.imageReferenceMaxPerCall) {
        throw new Error(`Too many reference images requested (${references.length}); maximum is ${deps.imageReferenceMaxPerCall} per call.`);
      }
      if (deps.enqueueImageJob !== undefined) {
        const replacesJobId = typeof p.replaces_job_id === "string" && p.replaces_job_id.trim() !== ""
          ? p.replaces_job_id.trim()
          : undefined;
        const enqueueResult = deps.enqueueImageJob({
          prompt,
          references,
          outputFormat: output,
          is4k,
          ...(replacesJobId !== undefined ? { replacesJobId } : {}),
        });
        if (!enqueueResult.created) {
          const assetHistory = enqueueResult.assetHistory.length === 0
            ? "(none available)"
            : enqueueResult.assetHistory.map((assetId) => `#${assetId}`).join(" → ");
          const text = renderOptionalPromptTemplate(
            deps.asyncJobAlreadyActiveTemplate,
            {
              jobId: enqueueResult.job.id,
              jobStatus: enqueueResult.job.status,
              reason: enqueueResult.reason,
              assetHistory,
            },
            `Image edit quality limit reached. Edit history: ${assetHistory}. Continue from the best earlier asset. Use read_asset to inspect its image and generation prompt if needed. Apply all later accepted changes and the current request in one complete prompt. For a generated asset, use its linked job ID as replaces_job_id. For the original source or a new image, omit it.`,
          );
          return {
            content: [{
              type: "text",
              text,
            }],
            details: {
              asyncJobId: enqueueResult.job.id,
              asyncJobStatus: enqueueResult.job.status,
              asyncJobCreated: false,
              is4k,
              reason: enqueueResult.reason,
              assetHistory: enqueueResult.assetHistory,
            },
          };
        }
        const text = renderOptionalPromptTemplate(
          deps.asyncJobStartedTemplate,
          {
            jobId: enqueueResult.job.id,
            jobStatus: enqueueResult.job.status,
          },
          `Started async image generation job ${enqueueResult.job.id}; do not wait for the image in this reply loop.`,
        );
        return {
          content: [{
            type: "text",
            text,
          }],
          details: {
            asyncJobId: enqueueResult.job.id,
            asyncJobStatus: enqueueResult.job.status,
            asyncJobCreated: true,
            is4k,
          },
        };
      }
      const referenceImages = await loadReferenceImages(deps, references, signal);
      const token = await getCodexApiKey(deps.codexAuthPath);
      const accountId = extractChatGptAccountId(token);
      const parsed = await requestImage({
        prompt,
        token,
        accountId,
        model: deps.model,
        outputFormat: output,
        is4k,
        imageGenerationQuality: deps.imageGenerationQuality,
        referenceImages,
        sessionId: deps.sessionId,
        enableDirectImageFallback: deps.enableDirectImageFallback,
        fetchFn: deps.fetchFn ?? fetch,
        signal,
        logger: deps.logger,
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(codexImageFailureMessageForAgent(message));
      });

      if (parsed.image === undefined) {
        if (parsed.failure !== undefined) {
          deps.logger?.warn("codex image generation failed", {
            model: deps.model,
            backendImageModel: BACKEND_IMAGE_MODEL,
            outputFormat: output,
            responseId: parsed.responseId,
            failure: parsed.failure,
            failureEvent: parsed.failureEvent,
            responseText: parsed.text.join("").trim(),
            responseHeaders: parsed.responseHeaders,
            diagnosticEvents: parsed.diagnosticEvents,
          });
          throw new Error(codexImageFailureMessageForAgent(codexFailureMessage(parsed)));
        }
        deps.logger?.warn("codex image generation returned no image", {
          model: deps.model,
          backendImageModel: BACKEND_IMAGE_MODEL,
          outputFormat: output,
          responseId: parsed.responseId,
          responseText: parsed.text.join("").trim(),
          responseHeaders: parsed.responseHeaders,
          diagnosticEvents: parsed.diagnosticEvents,
        });
        throw new Error(codexImageFailureMessageForAgent(codexFailureMessage(parsed)));
      }

      const buffer = Buffer.from(parsed.image.result, "base64");
      const actualMime = imageMimeFromBuffer(buffer, mimeForFormat(output));
      const actualSize = await imageSizeFromBuffer(buffer);
      const attachmentId = randomUUID();
      const filename = `codex-image-${attachmentId}.${imageExtensionForMime(actualMime)}`;
      const attachment: GeneratedImageAttachment = {
        id: attachmentId,
        buffer,
        filename,
        contentType: actualMime,
        prompt,
        revisedPrompt: parsed.image.revisedPrompt,
        requestedSize: parsed.requestedSize,
        actualSize,
        transport: parsed.transport,
        is4k,
      };
      const staged = deps.stageGeneratedImage === undefined
        ? undefined
        : await deps.stageGeneratedImage(attachment);
      if (staged === undefined) deps.onGeneratedImage(attachment);

      const summary = [
        `Generated image via openai-codex/${deps.model} using backend ${BACKEND_IMAGE_MODEL}.`,
        `Transport: ${parsed.transport}.`,
        `4K: ${is4k ? "yes" : "no"}.`,
        parsed.requestedSize !== undefined ? `Requested size: ${parsed.requestedSize}.` : "",
        actualSize !== undefined ? `Actual size: ${actualSize}.` : "",
        staged === undefined
          ? `Attachment ID: ${attachmentId}.`
          : `Staged asset ref: ${staged.assetRef}.`,
        references.length > 0 ? `References: ${JSON.stringify(references)}.` : "",
        "Status: ready.",
        parsed.image.revisedPrompt !== undefined ? `Revised prompt: ${parsed.image.revisedPrompt}` : "",
        staged === undefined
          ? "The runtime received the generated image."
          : `The image has not been sent. To post it, send a visible message with asset_ids=["${staged.assetRef}"] to the channel you choose. You may also inspect it or leave it unused.`,
      ].filter((part) => part !== "").join(" ");

      return {
        content: [{ type: "text", text: summary }],
        details: {
          ...(staged === undefined
            ? { generatedAttachmentIds: [attachmentId] }
            : { stagedAssetRef: staged.assetRef, workspacePath: staged.workspacePath }),
          provider: "openai-codex",
          model: deps.model,
          backendImageModel: BACKEND_IMAGE_MODEL,
          outputFormat: output,
          references,
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          transport: parsed.transport,
          is4k,
          requestedSize: parsed.requestedSize,
          actualSize,
          usage: parsed.usage,
        },
      };
    },
  };
}
