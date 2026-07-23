import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import {
  renderNotableRelationshipsContext,
  renderRelationshipPromptContext,
  selectRelationshipAnchorProfiles,
} from "./context";

describe("selectRelationshipAnchorProfiles", () => {
  test("selects at most two strong positive relationships by total investment", () => {
    const broad = emptyRelationshipProfile("broad", 1);
    broad.axes.trust = 30;
    broad.axes.warmth = 20;
    const warm = emptyRelationshipProfile("warm", 2);
    warm.axes.warmth = 40;
    const tense = emptyRelationshipProfile("tense", 3);
    tense.axes.tension = 100;
    tense.axes.familiarity = 100;
    const weak = emptyRelationshipProfile("weak", 4);
    weak.axes.warmth = 29;

    expect(selectRelationshipAnchorProfiles([weak, tense, warm, broad]).map((profile) => profile.userId))
      .toEqual(["broad", "warm"]);
  });
});

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

  test("renders relationship anchors in expanded form before compact recent users", () => {
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.warmth = 12;
    const anchor = emptyRelationshipProfile("u2", 2);
    anchor.axes.warmth = 40;
    anchor.notes.push("anchor note");
    anchor.recent.push({
      id: "anchor-signal",
      at: 2,
      summary: "anchor signal",
      visibility: "relationship-private",
    });
    const recent = emptyRelationshipProfile("u3", 3);
    recent.axes.trust = 12;
    recent.notes.push("recent note");

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      anchors: [{ profile: anchor, label: "@anchor / u2", reason: "anchor" }],
      others: [{ profile: recent, label: "@recent / u3", reason: "recent-chat" }],
    });

    expect(rendered).toContain("Relationship anchors:\n\n### @anchor / u2");
    expect(rendered).toContain("Notes: anchor note.");
    expect(rendered).toContain("Recent signals: anchor signal.");
    expect(rendered).toContain("Other relevant relationship profiles:\n- @recent / u3:");
    expect(rendered).not.toContain("### @recent / u3");
    expect(rendered.indexOf("Relationship anchors:")).toBeLessThan(rendered.indexOf("Other relevant relationship profiles:"));
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

describe("renderNotableRelationshipsContext", () => {
  test("renders three full profiles and keeps remaining people compact", () => {
    const profiles = Array.from({ length: 5 }, (_value, index) => {
      const profile = emptyRelationshipProfile(`u${index}`, index);
      profile.axes.trust = 12 + index;
      profile.notes.push(`note ${index}`);
      return { profile, label: `@user${index} / u${index}`, reason: "high-score" as const };
    });

    const rendered = renderNotableRelationshipsContext({
      full: profiles.slice(0, 3),
      compact: profiles.slice(3),
    });

    expect(rendered).toContain("### @user0 / u0");
    expect(rendered).toContain("Notes: note 0.");
    expect(rendered).toContain("### @user2 / u2");
    expect(rendered).toContain("Other known people:");
    expect(rendered).toContain("- @user3 / u3:");
    expect(rendered).not.toContain("### @user3 / u3");
  });
});
