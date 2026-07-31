import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import {
  renderNotableRelationshipsContext,
  renderRelationshipAxisValues,
  renderRelationshipMaintenanceContext,
  renderRelationshipPromptContext,
  selectRelationshipAnchorProfiles,
} from "./context";

describe("selectRelationshipAnchorProfiles", () => {
  test("selects strong positive, negative, and contradictory relationships by total salience", () => {
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
      .toEqual(["tense", "broad"]);
  });
});

describe("renderRelationshipPromptContext", () => {
  test("renders all raw axes and one combined portrait without recent event summaries", () => {
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
    other.axes.trust = -12;
    other.notes.push("other note.");

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      others: [{ profile: other, label: "@bob / u2", reason: "high-score" }],
      priorExchanges: "## Prior Exchanges With This Person\nUser: hi\n2B: hm",
    });

    expect(rendered).toContain("## Relationships");
    expect(rendered).toContain("Raw values and prose are private durable background.");
    expect(rendered).toContain("Subject: @alice / u1.");
    expect(rendered).not.toContain("Interaction history:");
    expect(rendered).toContain("Raw durable axes: familiarity=0, trust=14, warmth=15, respect=0, tension=0, curiosity=0, attraction=0, intimacy=10, attachment=0");
    expect(rendered).toMatch(/Contextual portrait \[growing-positive-\d\]:/);
    expect(rendered).toContain("Notes: first note; second note; third note.");
    expect(rendered).toContain("Boundaries: first boundary; second boundary.");
    expect(rendered).toContain("Open loops: first loop; second loop.");
    expect(rendered).toContain("## Prior Exchanges With This Person");
    expect(rendered).toContain("- @bob / u2: raw axes:");
    expect(rendered).not.toContain("Recent signals:");
    expect(rendered).not.toContain("first signal");
    expect(rendered).not.toContain(".;");
    expect(rendered).not.toContain("。;");
    expect(rendered).not.toContain(";;");
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
    expect(rendered).toContain("Raw durable axes:");
    expect(rendered).toContain("Contextual portrait [");
    expect(rendered).toContain("Notes: anchor note.");
    expect(rendered).toContain("Other relevant relationship profiles:\n- @recent / u3:");
    expect(rendered).not.toContain("anchor signal");
    expect(rendered).not.toContain("### @recent / u3");
    expect(rendered.indexOf("Relationship anchors:")).toBeLessThan(rendered.indexOf("Other relevant relationship profiles:"));
  });

  test("renders neutral raw state for a new current user", () => {
    const current = emptyRelationshipProfile("u1", 1);
    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
    });

    expect(rendered).toContain("Raw durable axes: familiarity=0, trust=0");
    expect(rendered).toMatch(/Contextual portrait \[unknown-neutral-\d\]:/);
    expect(rendered).toContain("No stored durable changes beyond the neutral defaults.");
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
    expect(rendered).toContain("- @bob / u2: raw axes:");
    expect(rendered).not.toContain("@2B");
    expect(rendered).not.toContain("Subject:");
  });

  test("omits an empty relationship section when an autonomous turn has no relevant profiles", () => {
    expect(renderRelationshipPromptContext({
      current: undefined,
      currentLabel: "@2B / bot",
      includeCurrent: false,
    })).toBe("");
  });
});

describe("renderRelationshipMaintenanceContext", () => {
  test("renders rounded axes, complete active lists, and recent applied changes", () => {
    const profile = emptyRelationshipProfile("u1", 1);
    profile.axes.trust = 35;
    profile.notes.push("one", "two");
    profile.boundaries.push("exact boundary");
    profile.openLoops.push("exact open matter");

    const rendered = renderRelationshipMaintenanceContext([{
      profile,
      label: "@alice (u1)",
      events: [{
        id: "event-1",
        type: "relationship_signal",
        at: 1,
        source: "llm",
        visibility: "relationship-private",
        guildId: "g1",
        channelId: "c1",
        userId: "u1",
        summary: "Trust dropped after a misread.",
        payload: { appliedAxes: { trust: -40 } },
        createdAt: 1,
      }],
    }]);

    expect(rendered).toContain("Raw durable axes: familiarity=0, trust=35");
    expect(rendered).toContain('Active boundaries:\n- "exact boundary"');
    expect(rendered).toContain('Open matters:\n- "exact open matter"');
    expect(rendered).toContain("event-1: trust=-40; Trust dropped after a misread.");
  });
});

describe("renderRelationshipAxisValues", () => {
  test("renders every score rounded to two decimal places", () => {
    const profile = emptyRelationshipProfile("u1", 1);
    profile.axes.familiarity = 14.450000000000003;
    profile.axes.trust = 35;
    profile.axes.tension = -12;

    expect(renderRelationshipAxisValues(profile)).toContain("familiarity=14.45");
    expect(renderRelationshipAxisValues(profile)).toContain("trust=35");
    expect(renderRelationshipAxisValues(profile)).toContain("tension=-12");
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
    expect(rendered).toContain("Raw durable axes:");
    expect(rendered).toContain("Notes: note 0.");
    expect(rendered).toContain("### @user2 / u2");
    expect(rendered).toContain("Other known people:");
    expect(rendered).toContain("- @user3 / u3: raw axes:");
    expect(rendered).not.toContain("### @user3 / u3");
  });
});
