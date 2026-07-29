import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  applyNotebookPatch,
  createNotebook,
  getNotebook,
  getNotebookRevision,
  listNotebookCandidates,
  listNotebookRevisions,
  patchNotebook,
  restoreNotebookRevision,
  restoreTrashedNotebook,
  rewriteNotebook,
  setNotebookState,
  shelfDueNotebooks,
  trashNotebook,
} from "./notebook-repository.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("notebook schema and discovery", () => {
  test("creates notebook tables and filters separate related users", () => {
    const tables = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'notebook%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "notebook_recall_users",
      "notebook_related_users",
      "notebook_revisions",
      "notebooks",
    ]);

    const first = createNotebook(db, {
      title: "Mira",
      relatedUserIds: ["u1"],
      recallMode: "users",
      recallUserIds: ["u2"],
      now: 100,
    });
    createNotebook(db, { title: "Other", relatedUserIds: ["u3"], now: 100 });

    expect(listNotebookCandidates(db, { relatedUserIds: ["u1"], now: 100 }).map((row) => row.id)).toEqual([first.id]);
    expect(first.relatedUserIds).toEqual(["u1"]);
    expect(first.recallUserIds).toEqual(["u2"]);
  });

  test("isolates active, shelved, archived, and trash states", () => {
    const active = createNotebook(db, { title: "Active", now: 100 });
    const shelved = createNotebook(db, { title: "Shelved", now: 100 });
    const archived = createNotebook(db, { title: "Archived", now: 100 });
    const trashed = createNotebook(db, { title: "Trashed", now: 100 });
    expect(setNotebookState(db, shelved.id, 1, "shelved", 200)).toHaveProperty("notebook.state", "shelved");
    expect(setNotebookState(db, archived.id, 1, "archived", 200)).toHaveProperty("notebook.state", "archived");
    expect(trashNotebook(db, trashed.id, 1, 200)).toHaveProperty("notebook.state", "trashed");

    expect(listNotebookCandidates(db, { state: "active", now: 200 }).map((row) => row.id)).toEqual([active.id]);
    expect(listNotebookCandidates(db, { state: "shelved", now: 200 }).map((row) => row.id)).toEqual([shelved.id]);
    expect(listNotebookCandidates(db, { state: "archived", now: 200 }).map((row) => row.id)).toEqual([archived.id]);
    expect(listNotebookCandidates(db, { state: "trashed", now: 200 }).map((row) => row.id)).toEqual([trashed.id]);
    expect(listNotebookCandidates(db, { now: 200 }).map((row) => row.id)).toEqual([
      active.id,
      shelved.id,
      archived.id,
    ]);
  });
});

describe("notebook shelving and concurrency", () => {
  test("uses the default week, supports shorter shelves, and renews only on edits", () => {
    const week = createNotebook(db, { title: "Week", now: 1_000 });
    const short = createNotebook(db, { title: "Short", shelfAfterMs: 500, now: 1_000 });
    expect(week.shelfAt).toBe(1_000 + 7 * 24 * 60 * 60 * 1000);
    expect(short.shelfAt).toBe(1_500);

    expect(getNotebook(db, short.id, 1_200)?.shelfAt).toBe(1_500);
    expect(listNotebookCandidates(db, { notebookId: short.id, now: 1_300 })[0]?.shelfAt).toBe(1_500);
    const rewritten = rewriteNotebook(db, short.id, {
      expectedRevision: 1,
      content: "renewed",
      now: 1_400,
    });
    expect(rewritten).toHaveProperty("notebook.shelfAt", 1_900);
    expect(rewritten).toHaveProperty("notebook.editedAt", 1_400);
  });

  test("shelves at the deadline and makes a simultaneous stale patch lose", () => {
    const notebook = createNotebook(db, {
      title: "Race",
      content: "## A\nold",
      shelfAfterMs: 100,
      now: 1_000,
    });
    const result = patchNotebook(db, notebook.id, 1, "@@ ## A\n-old\n+new", 1_100);
    expect(result).toEqual({
      error: "revision_conflict",
      expectedRevision: 1,
      currentRevision: 2,
      currentState: "shelved",
    });
    expect(getNotebook(db, notebook.id, 1_100)?.content).toBe("## A\nold");
    expect(getNotebookRevision(db, notebook.id, 2)?.operation).toBe("auto_shelve");
  });

  test("allows only one of two writers that read one revision", () => {
    const notebook = createNotebook(db, { title: "Writers", content: "## A\nold", now: 1_000 });
    expect(patchNotebook(db, notebook.id, 1, "@@ ## A\n-old\n+first", 1_100)).toHaveProperty("notebook.revision", 2);
    expect(patchNotebook(db, notebook.id, 1, "@@ ## A\n-old\n+second", 1_100)).toEqual({
      error: "revision_conflict",
      expectedRevision: 1,
      currentRevision: 2,
      currentState: "active",
    });
    expect(getNotebook(db, notebook.id, 1_100)?.content).toBe("## A\nfirst");
  });
});

describe("notebook patches and revisions", () => {
  test("applies several line hunks and rejects ambiguous context", () => {
    expect(applyNotebookPatch(
      "## A\nold one\nold two\n\n## B\nquestion",
      "@@ ## A\n-old one\n-old two\n+new one\n+new two\n\n@@ ## B\n-question\n+answer",
    )).toBe("## A\nnew one\nnew two\n\n## B\nanswer");
    expect(() => applyNotebookPatch("## A\nx\n## A\ny", "@@ ## A\n-x\n+z"))
      .toThrow("Patch context is ambiguous");
  });

  test("accepts a bare hunk header with a space-prefixed context", () => {
    expect(applyNotebookPatch(
      "## Сейчас\n- Макетка входного каскада на SN74LVC1G17.\n- Второй пороговый вход пока не ставлю.",
      "@@\n ## Сейчас\n-- Макетка входного каскада на SN74LVC1G17.\n-- Второй пороговый вход пока не ставлю.\n+- Макетка входного каскада на SN74LVC1G17 собрана.",
    )).toBe("## Сейчас\n- Макетка входного каскада на SN74LVC1G17 собрана.");
  });

  test("rolls back every hunk when one context fails", () => {
    const notebook = createNotebook(db, {
      title: "Rollback",
      content: "## A\nold\n\n## B\nquestion",
      now: 1_000,
    });
    const result = patchNotebook(
      db,
      notebook.id,
      1,
      "@@ ## A\n-old\n+new\n\n@@ ## Missing\n-question\n+answer",
      1_100,
    );
    expect(result).toHaveProperty("error", "invalid_patch");
    expect(getNotebook(db, notebook.id, 1_100)?.content).toBe(notebook.content);
    expect(getNotebook(db, notebook.id, 1_100)?.revision).toBe(1);
  });

  test("stores full snapshots, patch text, and restore as a new revision", () => {
    const notebook = createNotebook(db, { title: "History", content: "## A\nold", now: 1_000 });
    expect(patchNotebook(db, notebook.id, 1, "@@ ## A\n-old\n+new", 1_100))
      .toHaveProperty("notebook.revision", 2);
    const patchRevision = getNotebookRevision(db, notebook.id, 2);
    expect(patchRevision?.changeText).toBe("@@ ## A\n-old\n+new");
    expect(patchRevision?.snapshot.content).toBe("## A\nnew");

    expect(restoreNotebookRevision(db, notebook.id, 2, 1, undefined, 1_200))
      .toHaveProperty("notebook.revision", 3);
    expect(getNotebook(db, notebook.id, 1_200)?.content).toBe("## A\nold");
    expect(listNotebookRevisions(db, notebook.id, 100, 1_200).map((row) => row.operation))
      .toEqual(["restore_revision", "patch", "create"]);
  });

  test("keeps editedAt stable across lifecycle changes and requires activation before writes", () => {
    const notebook = createNotebook(db, { title: "Lifecycle", content: "old", now: 1_000 });
    expect(setNotebookState(db, notebook.id, 1, "shelved", 2_000)).toHaveProperty("notebook.editedAt", 1_000);
    expect(rewriteNotebook(db, notebook.id, { expectedRevision: 2, content: "blocked", now: 3_000 }))
      .toHaveProperty("error", "invalid_state");
    expect(setNotebookState(db, notebook.id, 2, "active", 3_000)).toHaveProperty("notebook.revision", 3);
    expect(rewriteNotebook(db, notebook.id, { expectedRevision: 3, content: "changed", now: 4_000 }))
      .toHaveProperty("notebook.editedAt", 4_000);

    expect(trashNotebook(db, notebook.id, 4, 5_000)).toHaveProperty("notebook.editedAt", 4_000);
    expect(restoreTrashedNotebook(db, notebook.id, 5, "archived", 6_000))
      .toHaveProperty("notebook.editedAt", 4_000);
  });

  test("auto-shelf saves a full lifecycle snapshot", () => {
    const notebook = createNotebook(db, { title: "Due", shelfAfterMs: 10, now: 100 });
    expect(shelfDueNotebooks(db, 110)).toBe(1);
    expect(getNotebookRevision(db, notebook.id, 2)).toMatchObject({
      operation: "auto_shelve",
      snapshot: { state: "shelved", editedAt: 100 },
    });
  });
});
