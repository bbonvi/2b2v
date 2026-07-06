import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import { renderRelationshipPromptContext } from "./context";

describe("renderRelationshipPromptContext", () => {
  test("names 2B relationship subject explicitly and keeps other users compact", () => {
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.warmth = 15;
    current.axes.trust = 14;
    current.axes.intimacy = 10;
    current.notes.push("comfortable with casual check-ins");
    current.boundaries.push("does not treat identity slurs from this user as banter");
    const other = emptyRelationshipProfile("u2", 1);
    other.axes.trust = 12;

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
    expect(rendered).toContain("Boundaries: does not treat identity slurs from this user as banter.");
    expect(rendered).toContain("- @bob / u2: 2B trusts them.");
    expect(rendered).not.toContain("Axes:");
    expect(rendered).not.toContain("trust +12");
    expect(rendered).not.toContain("Active speaker");
  });
});
