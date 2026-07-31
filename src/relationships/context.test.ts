import { describe, expect, test } from "bun:test";
import { emptyRelationshipProfile } from "./state";
import type { RelationshipAxes, RelationshipEvent } from "./types";
import {
  renderNotableRelationshipsContext,
  renderRelationshipAxisValues,
  renderRelationshipMaintenanceContext,
  renderRelationshipPromptContext,
  selectRelationshipAnchorProfiles,
} from "./context";

function relationshipEvent(
  id: string,
  at: number,
  axes: Partial<RelationshipAxes>,
  summary = id,
): RelationshipEvent {
  return {
    id,
    type: "relationship_signal",
    at,
    source: "llm",
    visibility: "relationship-private",
    guildId: "g1",
    channelId: "c1",
    userId: "u1",
    summary,
    payload: { appliedAxes: axes },
    createdAt: at,
  };
}

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
      priorExchanges: "#### Earlier exchanges with this person\nUser: hi\n2B: hm",
    });

    expect(rendered).toContain("## Relationships");
    expect(rendered).not.toContain("\n\n---\n\n### Current person");
    expect(rendered).toContain("### Current person\n\n@alice / u1");
    expect(rendered).not.toContain("Subject:");
    expect(rendered).not.toContain("Interaction history:");
    expect(rendered).toContain("How this relationship sits with you:");
    expect(rendered).not.toContain("Contextual portrait [");
    expect(rendered).toContain("Private reference values:\n\nfamiliarity=0, trust=14, warmth=15, respect=0, tension=0, curiosity=0, attraction=0, intimacy=10, attachment=0");
    expect(rendered.indexOf("How this relationship sits with you:"))
      .toBeLessThan(rendered.indexOf("Private reference values:"));
    expect(rendered).toContain("- Notes: first note; second note; third note.");
    expect(rendered).toContain("- Specific boundaries: first boundary; second boundary.");
    expect(rendered).toContain("- Unresolved matters: first loop; second loop.");
    expect(rendered).toContain("#### Earlier exchanges with this person");
    expect(rendered).toContain("### Other relevant people");
    expect(rendered).toContain("#### Others present or recently active");
    expect(rendered).toContain("- @bob / u2 —");
    expect(rendered).toContain("private values:");
    expect(rendered).not.toContain("\n\n---\n\n### Other relevant people");
    expect((rendered.match(/^---$/gmu) ?? [])).toHaveLength(0);
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

    expect(rendered).toContain("### Other relevant people");
    expect(rendered).toContain("#### People with lasting weight");
    expect(rendered).toContain("- @anchor / u2 —");
    expect(rendered).toContain("anchor note");
    expect(rendered).toContain("#### Others present or recently active");
    expect(rendered).toContain("- @recent / u3 —");
    expect(rendered).not.toContain("anchor signal");
    expect(rendered).not.toContain("#### @anchor / u2");
    expect(rendered).not.toContain("#### @recent / u3");
    expect(rendered.indexOf("#### People with lasting weight"))
      .toBeLessThan(rendered.indexOf("#### Others present or recently active"));
  });

  test("renders the combined compact portrait for a severe low-history anchor", () => {
    const current = emptyRelationshipProfile("u1", 1);
    const anchor = emptyRelationshipProfile("u2", 2);
    Object.assign(anchor.axes, {
      familiarity: 0.5,
      trust: -39.95,
      warmth: -65.75,
      respect: -33.33,
      tension: 33.33,
      intimacy: -1,
    });

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@current / u1",
      anchors: [{
        profile: anchor,
        label: "@fanmelina (Macan's Gaze) / 1013680913890160680",
        reason: "anchor",
      }],
    });

    expect(rendered).toContain("The history is thin; the aversion is not");
    expect(rendered).toContain("distinctly adverse shape");
    expect(rendered).toContain("private values: familiarity=0.5, trust=-39.95, warmth=-65.75");
    expect(rendered).not.toContain("Your first stable impression is wary rather than warm");
  });

  test("renders bounded seven-day movement for the current relationship", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 10 * day;
    const current = emptyRelationshipProfile("u1", 1);
    current.axes.trust = 20;
    current.axes.warmth = 30;
    const legacy = relationshipEvent("legacy", now - 3 * day, {}, "legacy warmth change");
    legacy.payload = { axes: { warmth: 5 } };
    const events = [
      relationshipEvent("old", now - 8 * day, { trust: -50 }, "old event"),
      relationshipEvent("smallest", now - day, { trust: -1 }, "smallest recent event"),
      relationshipEvent("recovery", now - 2 * day, { trust: 2 }, "partial recovery"),
      legacy,
      relationshipEvent("medium", now - 4 * day, { trust: -4 }, "medium trust loss"),
      relationshipEvent("largest", now - 5 * day, { trust: -5 }, "largest trust loss"),
    ];

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      currentEvents: events,
      now,
    });

    expect(rendered).toContain("Recent notable movement for this relationship (last 7 days):");
    expect(rendered).toContain("Across 5 recorded updates: trust -8, warmth +5.");
    expect(rendered).toContain("Recorded interpretation: \"largest trust loss\"");
    expect(rendered).toContain("Recorded interpretation: \"legacy warmth change\"");
    expect(rendered).toContain("Recorded interpretation: \"medium trust loss\"");
    expect(rendered).not.toContain("partial recovery");
    expect(rendered).not.toContain("smallest recent event");
    expect(rendered).not.toContain("old event");
    expect(rendered).toContain("not facts or a demand to repeat an old reaction");
  });

  test("shows detailed movement for the first anchor and compact movement for other people", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 10 * day;
    const current = emptyRelationshipProfile("u1", 1);
    const firstAnchor = emptyRelationshipProfile("u2", 2);
    firstAnchor.axes.warmth = 40;
    const secondAnchor = emptyRelationshipProfile("u3", 3);
    secondAnchor.axes.trust = 40;
    const recent = emptyRelationshipProfile("u4", 4);
    recent.axes.tension = 10;

    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@current / u1",
      anchors: [
        {
          profile: firstAnchor,
          label: "@first / u2",
          reason: "anchor",
          events: [relationshipEvent("first", now - day, { warmth: 5 }, "first anchor change")],
        },
        {
          profile: secondAnchor,
          label: "@second / u3",
          reason: "anchor",
          events: [relationshipEvent("second", now - day, { trust: -5 }, "second anchor change")],
        },
      ],
      others: [{
        profile: recent,
        label: "@recent / u4",
        reason: "recent-chat",
        events: [relationshipEvent("recent", now - day, { tension: 5 }, "recent user change")],
      }],
      now,
    });

    expect(rendered).toContain("Recent notable movement for @first / u2 (last 7 days):\nAcross 1 recorded update: warmth +5.");
    expect(rendered).toContain("Recorded interpretation: \"first anchor change\"");
    expect(rendered).toContain("Recent notable movement for @second / u3 (last 7 days): trust -5.");
    expect(rendered).not.toContain("second anchor change");
    expect(rendered).toContain("Recent notable movement for @recent / u4 (last 7 days): tension +5.");
    expect(rendered).not.toContain("recent user change");
  });

  test("omits recent movement after opposite changes reduce the net below five", () => {
    const now = 10_000;
    const current = emptyRelationshipProfile("u1", 1);
    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
      currentEvents: [
        relationshipEvent("loss", 8_000, { trust: -5 }),
        relationshipEvent("repair", 9_000, { trust: 4 }),
      ],
      now,
    });

    expect(rendered).not.toContain("Recent notable movement");
    expect(rendered).not.toContain("Recorded interpretation");
  });

  test("renders neutral raw state for a new current user", () => {
    const current = emptyRelationshipProfile("u1", 1);
    const rendered = renderRelationshipPromptContext({
      current,
      currentLabel: "@alice / u1",
    });

    expect(rendered).toContain("### Current person\n\n@alice / u1");
    expect(rendered).toContain("Private reference values:\n\nfamiliarity=0, trust=0");
    expect(rendered).not.toContain("Contextual portrait [");
    expect(rendered).toContain("No durable relationship changes are stored yet.");
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
    expect(rendered).toContain("### Other relevant people");
    expect(rendered).toContain("#### Others present or recently active");
    expect(rendered).toContain("- @bob / u2 —");
    expect(rendered).not.toContain("@2B");
    expect(rendered).not.toContain("### Current person");
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

    expect(rendered).toContain("### People with lasting weight");
    expect(rendered).toContain("#### @user0 / u0");
    expect(rendered).toContain("How this relationship sits with you:");
    expect(rendered).toContain("Private reference values:");
    expect(rendered).toContain("- Notes: note 0.");
    expect(rendered).toContain("#### @user2 / u2");
    expect(rendered).toContain("### Other known people");
    expect(rendered).toContain("- @user3 / u3 —");
    expect(rendered).not.toContain("#### @user3 / u3");
  });
});
