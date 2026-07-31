import {
  DEFAULT_ASSET_READING,
  DEFAULT_EXTERNAL_IMAGES,
  DEFAULT_IMAGE_GENERATION,
  DEFAULT_IMAGE_READING,
} from "./defaults.ts";
import type {
  AssetReadingConfig,
  AssetReadingConfigYaml,
  ExternalImagesConfig,
  GuildConfigYaml,
  ImageGenerationConfig,
  ImageGenerationQuality,
  ImageReadingConfig,
  MainConfigYaml,
} from "./types.ts";

export function resolveAssetReadingConfig(input: AssetReadingConfigYaml | undefined, fallback: AssetReadingConfig = DEFAULT_ASSET_READING): AssetReadingConfig {
  const positive = (value: number | undefined, fallback: number, name: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`assetReading.${name} must be positive`);
    return resolved;
  };
  const times = input?.videoPreviewTimesSeconds ?? [...fallback.videoPreviewTimesSeconds];
  if (times.length === 0 || times.length > 10 || times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new Error("assetReading.videoPreviewTimesSeconds must contain 1-10 non-negative numbers");
  }
  return {
    maxCharsPerRead: positive(input?.maxCharsPerRead, fallback.maxCharsPerRead, "maxCharsPerRead"),
    maxDownloadBytes: positive(input?.maxDownloadBytes, fallback.maxDownloadBytes, "maxDownloadBytes"),
    maxTranscriptionDurationSeconds: positive(input?.maxTranscriptionDurationSeconds, fallback.maxTranscriptionDurationSeconds, "maxTranscriptionDurationSeconds"),
    videoPreviewMaxBytes: positive(input?.videoPreviewMaxBytes, fallback.videoPreviewMaxBytes, "videoPreviewMaxBytes"),
    videoPreviewTimesSeconds: times,
    videoPreviewTimeoutSeconds: positive(input?.videoPreviewTimeoutSeconds, fallback.videoPreviewTimeoutSeconds, "videoPreviewTimeoutSeconds"),
    timeoutSeconds: {
      image: positive(input?.timeoutSeconds?.image, fallback.timeoutSeconds.image, "timeoutSeconds.image"),
      gif: positive(input?.timeoutSeconds?.gif, fallback.timeoutSeconds.gif, "timeoutSeconds.gif"),
      audio: positive(input?.timeoutSeconds?.audio, fallback.timeoutSeconds.audio, "timeoutSeconds.audio"),
      video: positive(input?.timeoutSeconds?.video, fallback.timeoutSeconds.video, "timeoutSeconds.video"),
      text: positive(input?.timeoutSeconds?.text, fallback.timeoutSeconds.text, "timeoutSeconds.text"),
      file: positive(input?.timeoutSeconds?.file, fallback.timeoutSeconds.file, "timeoutSeconds.file"),
      link: positive(input?.timeoutSeconds?.link, fallback.timeoutSeconds.link, "timeoutSeconds.link"),
    },
  };
}

export function resolveExternalImagesConfig(input: Partial<ExternalImagesConfig> | undefined): ExternalImagesConfig {
  const value = (key: keyof ExternalImagesConfig): number => {
    const resolved = input?.[key] ?? DEFAULT_EXTERNAL_IMAGES[key];
    if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`externalImages.${key} must be a positive integer`);
    return resolved;
  };
  return {
    maxImagesPerCall: value("maxImagesPerCall"),
    maxBytes: value("maxBytes"),
    timeoutMs: value("timeoutMs"),
    maxRedirects: value("maxRedirects"),
    maxDimension: value("maxDimension"),
    maxPageImages: value("maxPageImages"),
  };
}

export function resolveImageReferenceMaxPerCall(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return resolved;
}

export function resolveGlobalImageReading(
  partial: MainConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? DEFAULT_IMAGE_READING.fallbackEnabled,
    fallbackModelProfile: partial?.fallbackModelProfile ?? DEFAULT_IMAGE_READING.fallbackModelProfile,
  };
}

export function resolveGuildImageReading(
  global: ImageReadingConfig,
  partial: GuildConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? global.fallbackEnabled,
    fallbackModelProfile: partial?.fallbackModelProfile ?? global.fallbackModelProfile,
  };
}

function parseImageGenerationQuality(value: unknown, key: string): ImageGenerationQuality | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${key} must be "auto", "low", "medium", or "high"`);
}

export function resolveGlobalImageGeneration(
  partial: MainConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality")
      ?? DEFAULT_IMAGE_GENERATION.quality,
    modelProfile: partial?.modelProfile ?? DEFAULT_IMAGE_GENERATION.modelProfile,
  };
}

export function resolveGuildImageGeneration(
  global: ImageGenerationConfig,
  partial: GuildConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality") ?? global.quality,
    modelProfile: partial?.modelProfile ?? global.modelProfile,
  };
}

