import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  clearExpiredPrivateLifeThoughts,
  completePrivateLifeEpisode,
  countPrivateLifeVisibleEpisodesSince,
  createPrivateLifeEpisode,
  getPrivateLifeEpisode,
  listRecentPrivateLifeSummaries,
} from "./private-life-repository.ts";
import { createPrivateLifeSummaryTool } from "../private-life/summary-tool.ts";

describe("private-life episode repository", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("stores private output, compact novelty metadata, and visibility", async () => {
    createPrivateLifeEpisode(db, {
      id: "episode-1",
      guildId: "guild-1",
      channelId: "channel-1",
      dayPhase: "day",
      selection: {
        origin: "spontaneous",
        mode: "investigate",
        territory: "computing-systems",
        actionScope: "quiet-exploration",
        candidateSeeds: ["an undocumented chip, through a concrete failure"],
      },
      createdAt: 100,
    });
    completePrivateLifeEpisode(db, {
      id: "episode-1",
      requestId: "request-1",
      thoughts: "The undocumented chip is more interesting than expected.",
      visibleOutput: "I found something odd.",
      visibleDelivered: true,
      completedAt: 200,
    });
    const summaryTool = createPrivateLifeSummaryTool({
      db,
      episodeId: "episode-1",
      description: "Record a compact label.",
    });
    await summaryTool.execute("call-1", {
      label: "Undocumented chip",
      theme_key: "computing:undocumented-chip",
      facets: ["hardware", "Investigation", "hardware"],
    });

    expect(getPrivateLifeEpisode(db, "episode-1")).toMatchObject({
      requestId: "request-1",
      status: "complete",
      selection: { actionScope: "quiet-exploration" },
      thoughts: "The undocumented chip is more interesting than expected.",
      visibleDelivered: true,
      summary: {
        label: "Undocumented chip",
        themeKey: "computing:undocumented-chip",
        facets: ["hardware", "investigation"],
      },
    });
    expect(listRecentPrivateLifeSummaries(db, 10)[0]).toMatchObject({
      label: "Undocumented chip",
      territory: "computing-systems",
      mode: "investigate",
    });
    expect(countPrivateLifeVisibleEpisodesSince(db, 99)).toBe(1);
  });

  test("rejects long labels and clears old thought text without deleting summaries", async () => {
    createPrivateLifeEpisode(db, {
      id: "episode-2",
      guildId: "guild-1",
      channelId: "channel-1",
      dayPhase: "sleep-window",
      selection: {
        origin: "spontaneous",
        mode: "unstructured",
        territory: "open",
        actionScope: "reflect-only",
        candidateSeeds: [],
      },
      createdAt: 100,
    });
    completePrivateLifeEpisode(db, {
      id: "episode-2",
      thoughts: "A dream fragment.",
      visibleDelivered: false,
      completedAt: 150,
    });
    const tool = createPrivateLifeSummaryTool({ db, episodeId: "episode-2", description: "Record label." });
    const result = await tool.execute("call-2", {
      label: "one two three four five",
      theme_key: "dream:fragment",
      facets: [],
    });

    expect(result.details).toEqual({ recorded: false, error: "label_too_long" });
    expect(clearExpiredPrivateLifeThoughts(db, 101)).toBe(1);
    expect(getPrivateLifeEpisode(db, "episode-2")?.thoughts).toBeNull();
  });
});
