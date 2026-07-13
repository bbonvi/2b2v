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

  test("names 2B relationship subject explicitly and keeps other users compact", () => {
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

    expect(rendered).toContain("## Relationship With Current User");
    expect(rendered).toContain("This is 2B's stored relationship stance toward this user.");
    expect(rendered).toContain("Computed contact: observed history with this user; familiarity.");
    expect(rendered).toContain("Subject: @alice / u1.");
    expect(rendered).toContain("Relationship stance: 2B feels warm toward them, trusts them, and is slightly more personally open with them.");
    expect(rendered).toContain("Notes: first note; second note; third note.");
    expect(rendered).toContain("Boundaries: first boundary; second boundary.");
    expect(rendered).toContain("Open loops: first loop; second loop.");
    expect(rendered).toContain("Recent signals: first signal; second signal.");
    expect(rendered).toContain("- @bob / u2: 2B trusts them; other note.");
    expect(rendered).not.toContain(".;");
    expect(rendered).not.toContain("。;");
    expect(rendered).not.toContain(";;");
    expect(rendered).not.toContain("Axes:");
    expect(rendered).not.toContain("trust +12");
    expect(rendered).not.toContain("Active speaker");
  });
});
