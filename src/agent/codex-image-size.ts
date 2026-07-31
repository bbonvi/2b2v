import sharp from "sharp";

const MAX_GPT_IMAGE_EDGE = 3840;
const MAX_GPT_IMAGE_PIXELS = 8_294_400;
const GPT_IMAGE_SIZE_MULTIPLE = 16;

export interface ImageSize {
  width: number;
  height: number;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function infer4kAspectRatio(prompt: string): ImageSize {
  const text = normalizePrompt(prompt);
  const wantsWide = containsAny(text, [
    /\bwide\b/,
    /\blandscape\b/,
    /\bcinematic\b/,
    /\bbanner\b/,
    /\bwallpaper\b/,
    /\bwidescreen\b/,
    /\b16[:\s-]?9\b/,
  ]);
  if (wantsWide) return { width: 16, height: 9 };
  if (containsAny(text, [
    /\bvertical\b/,
    /\bportrait\b/,
    /\bselfie\b/,
    /\bphone\b/,
    /\bmobile\b/,
    /\b9[:\s-]?16\b/,
  ])) return { width: 9, height: 16 };
  if (containsAny(text, [
    /\bavatar\b/,
    /\bprofile\b/,
    /\bicon\b/,
    /\bsquare\b/,
    /\b1[:\s-]?1\b/,
  ])) return { width: 1, height: 1 };
  if (containsAny(text, [/\bposter\b/, /\bkey art\b/, /\bkeyart\b/])) return { width: 3, height: 2 };
  return { width: 1, height: 1 };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function reducedAspect(width: number, height: number): ImageSize {
  const divisor = gcd(width, height);
  return { width: width / divisor, height: height / divisor };
}

export function calculate4kImageSize(aspect: ImageSize): ImageSize {
  if (!Number.isFinite(aspect.width) || !Number.isFinite(aspect.height) || aspect.width <= 0 || aspect.height <= 0) {
    throw new Error("4K image aspect ratio must be positive.");
  }
  const reduced = reducedAspect(Math.round(aspect.width), Math.round(aspect.height));
  const ratio = Math.max(reduced.width, reduced.height) / Math.min(reduced.width, reduced.height);
  if (ratio > 3) throw new Error("4K image aspect ratio must be 3:1 or narrower.");
  if (reduced.width === 3 && reduced.height === 2) {
    const size = { width: 3520, height: 2336 };
    validate4kImageSize(size);
    return size;
  }
  if (reduced.width === 2 && reduced.height === 3) {
    const size = { width: 2336, height: 3520 };
    validate4kImageSize(size);
    return size;
  }

  const maxScaleByEdge = Math.floor(MAX_GPT_IMAGE_EDGE / Math.max(reduced.width, reduced.height));
  const maxScaleByPixels = Math.floor(Math.sqrt(MAX_GPT_IMAGE_PIXELS / (reduced.width * reduced.height)));
  let scale = Math.min(maxScaleByEdge, maxScaleByPixels);
  scale -= scale % GPT_IMAGE_SIZE_MULTIPLE;
  if (scale <= 0) throw new Error("4K image size could not satisfy backend constraints.");
  const size = {
    width: reduced.width * scale,
    height: reduced.height * scale,
  };
  validate4kImageSize(size);
  return size;
}

export function validate4kImageSize(size: ImageSize): void {
  if (size.width % GPT_IMAGE_SIZE_MULTIPLE !== 0 || size.height % GPT_IMAGE_SIZE_MULTIPLE !== 0) {
    throw new Error("4K image size edges must be multiples of 16.");
  }
  if (Math.max(size.width, size.height) > MAX_GPT_IMAGE_EDGE) {
    throw new Error("4K image size exceeds backend max edge.");
  }
  const ratio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  if (ratio > 3) throw new Error("4K image size exceeds backend aspect ratio limit.");
  if (size.width * size.height > MAX_GPT_IMAGE_PIXELS) {
    throw new Error("4K image size exceeds backend pixel limit.");
  }
}

export function formatImageSize(size: ImageSize): string {
  return `${size.width}x${size.height}`;
}

export async function imageSizeFromBuffer(buffer: Buffer): Promise<string | undefined> {
  try {
    const meta = await sharp(buffer).metadata();
    return `${meta.width}x${meta.height}`;
  } catch {
    return undefined;
  }
}


