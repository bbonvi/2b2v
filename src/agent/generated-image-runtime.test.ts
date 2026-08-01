import { expect, test } from "bun:test";
import {
  buildAsyncImageReadyMetadata,
  renderAgentJobsContext,
  renderImageGenerationInput,
} from "./generated-image-runtime";

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

test("renders compact actual metadata and conditional 4K guidance", () => {
  expect(buildAsyncImageReadyMetadata({
    requestedSize: "3584x2240",
    requestedFormat: "webp",
    actualSize: "1586x992",
    actualContentType: "image/png",
    byteSize: 1_600_631,
    transport: "direct-edits",
    is4k: true,
  })).toEqual({
    requestedMetadata: "3584x2240, WebP",
    resultMetadata: "1586x992, PNG, 1.5MB",
    transportLine: "Transport: direct-edits\n",
    is4k: "yes",
    fourKNote: " (best-effort; the provider may return a smaller image)",
  });

  expect(buildAsyncImageReadyMetadata({
    requestedFormat: "jpeg",
    actualContentType: "image/jpeg",
    byteSize: 900,
    is4k: false,
  })).toEqual({
    requestedMetadata: "JPEG",
    resultMetadata: "JPEG, 900B",
    transportLine: "",
    is4k: "no",
    fourKNote: "",
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
  }], "g1", "c1", 3_000, () => [{ assetId: 42 }]);

  expect(rendered).toContain("## Agent Jobs");
  expect(rendered).toContain('prompt: "Actual detailed moonlit portrait prompt"');
  expect(rendered).toContain("sent MsgID m2; assets #42");
  expect(rendered).not.toContain("quote:");
});

test("renders global background-agent ownership, yield time, and handoff", () => {
  const yieldedAt = Date.parse("2026-08-01T12:00:00.000Z");
  const rendered = renderAgentJobsContext([{
    id: "persona-abc123",
    kind: "persona_task",
    guildId: "other-guild",
    channelId: "other-channel",
    deliveryGuildId: "other-guild",
    deliveryChannelId: "other-channel",
    requesterId: "u2",
    requesterUsername: "bob",
    sourceMessageId: "m2",
    sourceQuote: "check on them",
    status: "yielded",
    createdAt: yieldedAt - 60_000,
    startedAt: yieldedAt - 30_000,
    completedAt: yieldedAt,
    input: {
      taskName: "check-in",
      message: "Check another guild and report what happened.",
      pendingMessages: [],
    },
    result: {
      handoff: "The check is complete.",
      yieldedAt,
      notificationPending: false,
      notificationDeliveredAt: yieldedAt + 1_000,
    },
    replacementCount: 0,
  }], "current-guild", "current-channel", yieldedAt + 120_000);

  expect(rendered).toContain("persona_task yielded (paused) (active, elsewhere)");
  expect(rendered).toContain("origin guild other-guild channel other-channel MsgID m2");
  expect(rendered).toContain(`yielded ${new Date(yieldedAt).toISOString()} (2m ago)`);
  expect(rendered).toContain('task "check-in": "Check another guild and report what happened."');
  expect(rendered).toContain('handoff: "The check is complete."');
});

test("renders stopped time for dismissed agent jobs", () => {
  const stoppedAt = Date.parse("2026-08-01T12:00:00.000Z");
  const rendered = renderAgentJobsContext([{
    id: "agent-stopped",
    kind: "persona_task",
    guildId: "g1",
    channelId: "c1",
    deliveryGuildId: "g1",
    deliveryChannelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "stop",
    status: "dismissed",
    createdAt: stoppedAt - 60_000,
    completedAt: stoppedAt,
    input: { taskName: "done", message: "Done.", pendingMessages: [] },
    replacementCount: 0,
  }], "g1", "c1", stoppedAt + 60_000);

  expect(rendered).toContain("dismissed (stopped) (recent terminal, here)");
  expect(rendered).toContain(`stopped ${new Date(stoppedAt).toISOString()} (1m ago)`);
});
