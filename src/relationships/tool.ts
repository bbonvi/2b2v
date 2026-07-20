import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database";
import { applyRelationshipSignals, type RelationshipMutationResult } from "./engine";
import type { RelationshipConfig, RelationshipScope, RelationshipSignalInput } from "./types";
import { RELATIONSHIP_AXES, RELATIONSHIP_VISIBILITIES } from "./state";

const AxesSchema = Type.Object(Object.fromEntries(
  RELATIONSHIP_AXES.map((axis) => [axis, Type.Optional(Type.Number({ minimum: -10, maximum: 10 }))]),
), { additionalProperties: false });

const SignalSchema = Type.Object({
  userId: Type.Optional(Type.String({ minLength: 1 })),
  summary: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  visibility: Type.Optional(Type.String({ enum: [...RELATIONSHIP_VISIBILITIES] })),
  axes: Type.Optional(AxesSchema),
  note: Type.Optional(Type.String({ minLength: 1 })),
  boundary: Type.Optional(Type.String({ minLength: 1 })),
  openLoop: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RecordRelationshipSchema = Type.Object({
  signals: Type.Array(SignalSchema, { maxItems: 6 }),
}, { additionalProperties: false });

type RecordRelationshipParams = Static<typeof RecordRelationshipSchema>;

type RecordRelationshipToolResult = AgentToolResult<RelationshipMutationResult | { error: true }>;

export interface RecordRelationshipToolDeps {
  db: Database;
  config: RelationshipConfig;
  scope?: RelationshipScope;
  dryRun?: boolean;
  description?: string;
  onResult?: (result: RelationshipMutationResult, signals: RelationshipSignalInput[]) => void;
}

export function createRecordRelationshipTool(deps: RecordRelationshipToolDeps): AgentTool {
  return {
    name: "record_relationship",
    label: "record_relationship",
    description: deps.description?.trim() !== ""
      ? deps.description ?? "Record durable relationship state after a Discord turn."
      : "Record durable relationship state after a Discord turn.",
    parameters: RecordRelationshipSchema,
    prepareArguments: (params: unknown): RecordRelationshipParams => {
      if (params !== null && typeof params === "object" && !Array.isArray(params)) {
        const signals = (params as Record<string, unknown>).signals;
        if (Array.isArray(signals)) {
          const allowedAxes = new Set<string>(RELATIONSHIP_AXES);
          for (const [index, signal] of signals.entries()) {
            if (signal === null || typeof signal !== "object" || Array.isArray(signal)) continue;
            const axes = (signal as Record<string, unknown>).axes;
            if (axes === null || typeof axes !== "object" || Array.isArray(axes)) continue;
            const unknownAxis = Object.keys(axes).find((axis) => !allowedAxes.has(axis));
            if (unknownAxis !== undefined) {
              throw new Error(
                `signals[${index}].axes.${unknownAxis} is unknown; allowed axes: ${RELATIONSHIP_AXES.join(", ")}`,
              );
            }
          }
        }
      }
      return params as RecordRelationshipParams;
    },
    execute: (_toolCallId: string, params: unknown): Promise<RecordRelationshipToolResult> => {
      if (!Value.Check(RecordRelationshipSchema, params)) {
        return Promise.resolve({
          content: [{ type: "text", text: "Relationship update rejected: arguments did not match the schema." }],
          details: { error: true },
        });
      }
      const signals = (params as { signals: RelationshipSignalInput[] }).signals;
      const result = applyRelationshipSignals(deps.db, deps.config, {
        signals,
        source: "llm",
        scope: deps.scope,
        dryRun: deps.dryRun,
      });
      deps.onResult?.(result, signals);
      const rejected = result.rejected
        .map(({ signal, reason }, index) => `signals[${signals.indexOf(signal) >= 0 ? signals.indexOf(signal) : index}]: ${reason}`)
        .join("\n");
      return Promise.resolve({
        content: [{
          type: "text",
          text: rejected === ""
            ? `Relationship update complete; accepted ${result.accepted.length} of ${signals.length} signal(s).`
            : `Relationship update accepted ${result.accepted.length} of ${signals.length} signal(s); retry only these rejected signals:\n${rejected}`,
        }],
        details: result,
      });
    },
  };
}
