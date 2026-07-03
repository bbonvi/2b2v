import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import { renderRelationshipPromptContext } from "./context";

describe("renderRelationshipPromptContext", () => {
  test("names 2B relationship subject explicitly and keeps other users compact", () => {
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.warmth = 6;
    current.notes.push("comfortable with casual check-ins");
    const other = emptyRelationshipProfile("u2", 1);
    other.axes.trust = 12;

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      computedContact: "observed history with this user; familiarity, not intimacy.",
      others: [{ profile: other, label: "@bob / u2", reason: "high-score" }],
    });

    expect(rendered).toContain("## Relationship With Current User");
    expect(rendered).toContain("This is 2B's stored relationship stance toward this user.");
    expect(rendered).toContain("Computed contact: observed history with this user; familiarity, not intimacy.");
    expect(rendered).toContain("Subject: @alice / u1.");
    expect(rendered).toContain("- @bob / u2: trust +12");
    expect(rendered).not.toContain("Active speaker");
  });
});
