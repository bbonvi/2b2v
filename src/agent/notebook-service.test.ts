import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createDatabase, type Database } from "../db/database.ts";
import {
  createNotebook,
  patchNotebook,
  setNotebookState,
  trashNotebook,
} from "../db/notebook-repository.ts";
import {
  buildNotebooksContext,
  createNotebookTools,
  formatNaturalCount,
} from "./notebook-service.ts";
import { isToolAllowedInMaintenance } from "./tool-effects.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function tools(): AgentTool[] {
  return createNotebookTools({
    db,
    currentGuildId: "g1",
    defaultShelfAfterMs: 7 * 24 * 60 * 60 * 1000,
  });
}

function namedTool(name: string): AgentTool {
  const tool = tools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function text(tool: AgentTool, params: unknown): Promise<string> {
  const result = await tool.execute("call-1", params, AbortSignal.timeout(10_000));
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

describe("notebook tools", () => {
  test("keeps reads available and blocks notebook mutation from semantic maintenance", () => {
    expect(isToolAllowedInMaintenance(namedTool("find_notebooks"), "record_memory")).toBe(true);
    expect(isToolAllowedInMaintenance(namedTool("search_notebook"), "record_memory")).toBe(true);
    expect(isToolAllowedInMaintenance(namedTool("read_notebook"), "record_memory")).toBe(true);
    expect(isToolAllowedInMaintenance(namedTool("manage_notebook"), "record_memory")).toBe(false);
    expect(isToolAllowedInMaintenance(namedTool("patch_notebook"), "record_memory")).toBe(false);
  });

  test("finds notebooks by title or content with exact metadata and ID pagination", async () => {
    const now = Date.now();
    const first = createNotebook(db, {
      title: "Antenna noise",
      content: "The rail has a harmonic.",
      relatedUserIds: ["u1"],
      now,
    });
    const second = createNotebook(db, { title: "Power", content: "No antenna data.", now: now + 1 });
    createNotebook(db, { title: "Third", content: "Quiet.", now: now + 2 });
    const find = namedTool("find_notebooks");

    const byTitle = await text(find, { pattern: "^Antenna", limit: 10 });
    expect(byTitle).toContain(`Notebook: ${first.id} | Antenna noise`);
    expect(byTitle).toContain("Current revision: 1");
    expect(byTitle).toContain(`Created: ${new Date(now).toISOString()} (${now})`);
    expect(byTitle).toContain(`Last edit: ${new Date(now).toISOString()} (${now})`);
    expect(byTitle).toContain("Related users: u1");
    expect(byTitle).toContain("Recall scope: anywhere");
    expect(byTitle).toContain("title | Antenna noise");

    const firstPage = await text(find, { limit: 1 });
    expect(firstPage).toContain(`Notebook: ${first.id} | Antenna noise`);
    expect(firstPage).toContain(`next_after_id=${first.id}`);
    const secondPage = await text(find, { after_id: first.id, limit: 1 });
    expect(secondPage).toContain(`Notebook: ${second.id} | Power`);
  });

  test("searches one notebook by physical line with line continuation", async () => {
    const notebook = createNotebook(db, {
      title: "Signals",
      content: "header\nfirst harmonic\nmiddle\nsecond harmonic\nfooter",
      now: 1_000,
    });
    const search = namedTool("search_notebook");

    const first = await text(search, {
      notebook_id: notebook.id,
      pattern: "harmonic",
      max_results: 1,
      context_lines: 0,
    });
    expect(first).toContain("> 2 | first harmonic");
    expect(first).toContain("next_start_line=3");

    const second = await text(search, {
      notebook_id: notebook.id,
      pattern: "harmonic",
      start_line: 3,
      max_results: 1,
      context_lines: 0,
    });
    expect(second).toContain("> 4 | second harmonic");
    expect(second).not.toContain("next_start_line");
    expect(await text(search, { notebook_id: notebook.id, pattern: "missing" })).toContain("No matches");
  });

  test("shows trash only through explicit trash search", async () => {
    const notebook = createNotebook(db, { title: "Trash", now: 1_000 });
    trashNotebook(db, notebook.id, 1, 2_000);
    const search = namedTool("find_notebooks");
    expect(await text(search, {})).not.toContain("Trash");
    expect(await text(search, { state: "active+shelved+archived" })).not.toContain("Trash");
    expect(await text(search, { state: "trashed" })).toContain("Trash");
  });

  test("reads physical line ranges and inspects patch changes", async () => {
    const notebook = createNotebook(db, {
      title: "Lines",
      content: "## A\none very long physical line\nthree",
      now: 1_000,
    });
    patchNotebook(db, notebook.id, 1, "@@ ## A\n-one very long physical line\n+two", 2_000);
    const read = namedTool("read_notebook");

    const content = await text(read, {
      notebook_id: notebook.id,
      revision: 1,
      start_line: 2,
      line_count: 1,
    });
    expect(content).toContain("2 | one very long physical line");
    expect(content).not.toContain("3 | three");

    const change = await text(read, { notebook_id: notebook.id, revision: 2, view: "change" });
    expect(change).toContain("1 | @@ ## A");
    expect(change).toContain("2 | -one very long physical line");
    expect(change).toContain("3 | +two");
  });

  test("lists revision operation and exact time", async () => {
    const notebook = createNotebook(db, { title: "History", now: 1_000 });
    setNotebookState(db, notebook.id, 1, "shelved", 2_000);
    const output = await text(namedTool("list_notebook_revisions"), { notebook_id: notebook.id });
    expect(output).toContain("r2 | shelved | 1970-01-01T00:00:02.000Z (2000)");
    expect(output).toContain("r1 | create | 1970-01-01T00:00:01.000Z (1000)");
  });
});

describe("notebook prompt index", () => {
  test("uses every natural count bucket boundary", () => {
    expect([0, 1, 2, 4, 5, 7, 8, 19, 20, 49, 50, 99, 100].map(formatNaturalCount)).toEqual([
      "",
      "1",
      "a few",
      "a few",
      "about 5",
      "about 5",
      "about 10",
      "about 10",
      "about 30",
      "about 30",
      "about 50",
      "about 50",
      "over 100",
    ]);
  });

  test("selects active first, renders shelved first, and preserves creation order", () => {
    const shelved = createNotebook(db, { title: "Old shelf", now: 1_000 });
    setNotebookState(db, shelved.id, 1, "shelved", 2_000);
    const activeOne = createNotebook(db, { title: "First active", now: 3_000 });
    const activeTwo = createNotebook(db, { title: "Second active", now: 4_000 });
    const output = buildNotebooksContext({
      db,
      guildId: "g1",
      maxTitles: 2,
      now: 5_000,
    });
    expect(output).not.toContain("Old shelf");
    expect(output).toContain("### Shelved\n\nAnd 1 more.");
    expect(output.indexOf(`${activeOne.id} | First active`))
      .toBeLessThan(output.indexOf(`${activeTwo.id} | Second active`));
    expect(output.indexOf("### Shelved")).toBeLessThan(output.indexOf("### Active"));
  });

  test("uses shared rough age for shelves and keeps active body edits out of row text", () => {
    const now = 40 * 24 * 60 * 60 * 1000;
    const shelved = createNotebook(db, { title: "Shelf", now: now - 30 * 24 * 60 * 60 * 1000 });
    setNotebookState(db, shelved.id, 1, "shelved", now - 20 * 24 * 60 * 60 * 1000);
    const active = createNotebook(db, { title: "Active title", content: "## Body\nold body", now: now - 1_000 });
    patchNotebook(db, active.id, 1, "@@ ## Body\n-old body\n+new body", now);
    const output = buildNotebooksContext({ db, guildId: "g1", maxTitles: 10, now });
    expect(output).toContain(`${shelved.id} [1mo] | Shelf`);
    expect(output).toContain(`${active.id} | Active title`);
    expect(output).not.toContain("new body");
    expect(output).not.toMatch(new RegExp(`${active.id} \\[`));
  });

  test("filters recall scope and presence triggers and reports cold totals", () => {
    createNotebook(db, { title: "Anywhere", now: 1_000 });
    createNotebook(db, {
      title: "Guild two",
      recallScope: "guild",
      recallGuildId: "g2",
      now: 1_000,
    });
    createNotebook(db, {
      title: "Mira present",
      recallMode: "users",
      recallUserIds: ["u1"],
      now: 1_000,
    });
    const archived = createNotebook(db, { title: "Cold", now: 1_000 });
    setNotebookState(db, archived.id, 1, "archived", 2_000);
    const trashed = createNotebook(db, { title: "Gone", now: 1_000 });
    trashNotebook(db, trashed.id, 1, 2_000);

    const absent = buildNotebooksContext({ db, guildId: "g1", visibleUserIds: [], maxTitles: 10, now: 3_000 });
    expect(absent).toContain("Anywhere");
    expect(absent).not.toContain("Guild two");
    expect(absent).not.toContain("Mira present");
    expect(absent).not.toContain("Cold");
    expect(absent).not.toContain("Gone");
    expect(absent).toContain("1 archived and 1 trashed notebooks are stored separately.");

    const present = buildNotebooksContext({ db, guildId: "g1", visibleUserIds: ["u1"], maxTitles: 10, now: 3_000 });
    expect(present).toContain("Mira present");
  });

  test("reports per-state overflow rather than total rows", () => {
    for (let index = 0; index < 5; index += 1) {
      createNotebook(db, { title: `Active ${index}`, now: 1_000 + index });
    }
    const shelved = createNotebook(db, { title: "Shelf", now: 1_000 });
    setNotebookState(db, shelved.id, 1, "shelved", 2_000);
    const output = buildNotebooksContext({ db, guildId: "g1", maxTitles: 3, now: 3_000 });
    expect(output).toContain("### Active");
    expect(output).toContain("And a few more.");
    expect(output).toContain("### Shelved\n\nAnd 1 more.");
  });
});
