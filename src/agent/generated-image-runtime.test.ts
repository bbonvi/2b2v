import { expect, test } from "bun:test";
import { renderAgentJobsContext, renderImageGenerationInput } from "./generated-image-runtime";

test("renders the complete effective image generation input", () => {
  const rendered = renderImageGenerationInput({
    prompt: "Use both references",
    references: [
      { type: "asset", assetId: 12 },
      { type: "avatar", userId: "123456789012345678" },
      { type: "url", url: "https://example.com/reference.gif" },
    ],
    outputFormat: "webp",
    is4k: true,
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
    replaces_job_id: "img-old",
  });
});

test("renders compact actual prompts and durable output assets in job context", () => {
  const rendered = renderAgentJobsContext([{
    id: "img-abc123",
    kind: "image_generation",
    guildId: "g1",
    channelId: "c1",
    deliveryGuildId: "g1",
    deliveryChannelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "make it better",
    status: "delivered",
    createdAt: 1_000,
    completedAt: 2_000,
    sentMessageId: "m2",
    input: {
      prompt: "Actual detailed moonlit portrait prompt",
      references: [],
      outputFormat: "webp",
      is4k: false,
    },
    replacementCount: 0,
  }], "Async jobs.", 3_000, () => [{ assetId: 42 }]);

  expect(rendered).toContain("## Image Jobs");
  expect(rendered).toContain('prompt: "Actual detailed moonlit portrait prompt"');
  expect(rendered).toContain("sent MsgID m2 assets #42");
  expect(rendered).not.toContain("quote:");
});
