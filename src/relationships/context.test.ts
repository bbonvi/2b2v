import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import { renderRelationshipPromptContext } from "./context";

describe("renderRelationshipPromptContext", () => {
  test("surfaces faint selective feelings before stronger relationship axes", () => {
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.warmth = 2;
    current.axes.curiosity = 2;
    current.axes.attraction = 2;
    current.axes.intimacy = 2;

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
    });

    expect(rendered).toContain("has some warmth toward them");
    expect(rendered).toContain("is a little curious about them");
    expect(rendered).toContain("notices a faint private pull toward them");
    expect(rendered).not.toContain("personally open");
  });

  test("addresses the active persona directly and keeps other users compact", () => {
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.warmth = 15;
    current.axes.trust = 14;
    current.axes.intimacy = 10;
    current.notes.push("first note.", "second note。", "third note;");
    current.boundaries.push("first boundary.", "second boundary.");
    current.openLoops.push("first loop.", "second loop.");
    current.recent.push(
      { id: "r1", at: 1, summary: "first signal.", visibility: "relationship-private" },
      { id: "r2", at: 2, summary: "second signal.", visibility: "relationship-private" },
    );
    const other = emptyRelationshipProfile("u2", 1);
    other.axes.trust = 12;
    other.notes.push("other note.");

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      computedContact: "observed history with this user; familiarity.",
      others: [{ profile: other, label: "@bob / u2", reason: "high-score" }],
    });

    expect(rendered).toContain("## Relationships");
    expect(rendered).toContain("This is your stored relationship stance toward this user.");
    expect(rendered).toContain("Computed contact: observed history with this user; familiarity.");
    expect(rendered).toContain("Subject: @alice / u1.");
    expect(rendered).toContain("Relationship stance: The persona feels warm toward them, trusts them, and is slightly more personally open with them.");
    expect(rendered).toContain("Notes: first note; second note; third note.");
    expect(rendered).toContain("Boundaries: first boundary; second boundary.");
    expect(rendered).toContain("Open loops: first loop; second loop.");
    expect(rendered).toContain("Recent signals: first signal; second signal.");
    expect(rendered).toContain("- @bob / u2: The persona trusts them; other note.");
    expect(rendered).not.toContain(".;");
    expect(rendered).not.toContain("。;");
    expect(rendered).not.toContain(";;");
    expect(rendered).not.toContain("Axes:");
    expect(rendered).not.toContain("trust +12");
    expect(rendered).not.toContain("Active speaker");
  });

  test("omits the current subject during autonomous turns while retaining other profiles", () => {
    const other = emptyRelationshipProfile("u2", 1);
    other.axes.trust = 12;

    const rendered = renderRelationshipPromptContext({
      current: undefined,
      currentLabel: "@2B / bot",
      others: [{ profile: other, label: "@bob / u2", reason: "recent-chat" }],
      includeCurrent: false,
    });

    expect(rendered).toContain("## Relationships");
    expect(rendered).toContain("Other relevant relationship profiles:");
    expect(rendered).toContain("- @bob / u2: The persona trusts them.");
    expect(rendered).not.toContain("@2B");
    expect(rendered).not.toContain("Subject:");
    expect(rendered).not.toContain("No stored relationship profile yet.");
    expect(rendered).not.toContain("current user");
  });

  test("omits an empty relationship section when an autonomous turn has no relevant profiles", () => {
    expect(renderRelationshipPromptContext({
      current: undefined,
      currentLabel: "@2B / bot",
      includeCurrent: false,
    })).toBe("");
  });
});
