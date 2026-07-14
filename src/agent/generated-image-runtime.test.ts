import { expect, test } from "bun:test";
import { renderImageGenerationInput } from "./generated-image-runtime";

test("renders the complete effective image generation input without internal fields", () => {
  const rendered = renderImageGenerationInput({
    prompt: "Use both references",
    promptHash: "internal-hash",
    references: [
      { type: "asset", assetId: 12 },
      { type: "avatar", userId: "123456789012345678" },
      { type: "url", url: "https://example.com/reference.gif" },
    ],
    outputFormat: "webp",
    is4k: true,
    separateJob: true,
    allowsGroupCorrections: true,
    replacesJobId: "img-old",
  });

  expect(JSON.parse(rendered)).toEqual({
    prompt: "Use both references",
    reference_images: [
      { type: "asset", asset_id: 12 },
      { type: "avatar", user_id: "123456789012345678" },
      { type: "url", url: "https://example.com/reference.gif" },
    ],
    output_format: "webp",
    "4k": true,
    separate_job: true,
    allows_group_corrections: true,
    replaces_job_id: "img-old",
  });
  expect(rendered).not.toContain("promptHash");
});
