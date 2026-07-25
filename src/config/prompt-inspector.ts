import { createHash } from "crypto";
import type {
  LlmProvider,
  PromptTransportConfig,
  PromptTransportSectionId,
  PromptTransportTarget,
} from "./types.ts";
import type {
  PromptBundle,
  PromptDocument,
  PromptInstructionLayer,
  PromptSourceSelection,
} from "./instruction-bundle.ts";
import { CODEX_IMAGE_GENERATION_INSTRUCTIONS } from "../agent/codex-image-prompts.ts";

export const PROMPT_SCENARIO_IDS = [
  "discord",
  "scheduled-task",
  "event-watch",
  "event-watch-with-trigger",
  "ambient-pickup",
  "lingering-attention",
  "follow-up",
  "ambient-initiative-actor",
  "async-image-ready",
  "async-image-failed",
  "routed-reply",
  "private-life-actor",
  "voice-actor",
  "memory-maintenance",
  "ambient-memory-maintenance",
  "relationship-maintenance",
  "inner-thread-maintenance",
  "private-life-maintenance",
  "ambient-attention-evaluator-ambient-pickup",
  "ambient-attention-evaluator-lingering-attention",
  "ambient-attention-evaluator-follow-up",
  "ambient-initiative-evaluator",
  "image-reading-fallback",
  "image-generation",
  "image-generation-direct",
  "image-edit-direct",
  "voice-summary",
  "voice-extraction",
] as const;

export type PromptScenarioId = typeof PROMPT_SCENARIO_IDS[number];
export type PromptInspectionPhase = "stable" | "volatile" | "final" | "pass";
export type PromptInspectionStatus =
  | "included"
  | "generated"
  | "code"
  | "template"
  | "conditional"
  | "unselected";

interface PromptBlockDefinition {
  groupId?: string;
  code?: {
    source: string;
    text: string;
  };
  phase: PromptInspectionPhase;
  transportSection?: PromptTransportSectionId;
  directPlacement?: "system" | "control";
  renderedTemplate?: boolean;
  reason: string;
  mergeKey?: string;
}

interface PromptScenarioDefinition {
  id: PromptScenarioId;
  label: string;
  family: "actor" | "maintenance" | "evaluator" | "fallback" | "generation";
  fixedProvider?: LlmProvider;
  description: string;
  blocks: PromptBlockDefinition[];
  dynamicSections: string[];
}

const CORE_ACTOR_BLOCKS: PromptBlockDefinition[] = [
  {
    groupId: "core.system",
    phase: "stable",
    transportSection: "system",
    reason: "Highest-level stable behavior policy.",
  },
  {
    groupId: "core.persona",
    phase: "stable",
    transportSection: "core",
    reason: "Stable identity and persona.",
  },
  {
    groupId: "core.style",
    phase: "stable",
    transportSection: "core",
    reason: "Stable voice and style.",
  },
  {
    groupId: "generated.skills-index",
    phase: "stable",
    transportSection: "skills",
    reason: "Generated index of skills available through load_skill.",
  },
  {
    groupId: "core.runtime",
    phase: "stable",
    transportSection: "runtime",
    reason: "Default text actor runtime.",
  },
];

const TEXT_FINAL_BLOCKS: PromptBlockDefinition[] = [
  {
    groupId: "surface.text.execution-mode",
    phase: "final",
    transportSection: "finalActionInstruction",
    reason: "Normal visible actor execution mode.",
    mergeKey: "final-action",
  },
  {
    groupId: "surface.text.final-action",
    phase: "final",
    transportSection: "finalActionInstruction",
    reason: "Default text actor action boundary.",
    mergeKey: "final-action",
  },
];

const BASE_DYNAMIC_SECTIONS = [
  "Stable context and older history, when present.",
  "Guild, channel, schedules, memories, inner threads, recent history, members, and thread metadata, when present.",
  "Current event metadata, text, and attached images.",
  "Persona mode and response instruction overlays, when active.",
  "Tool schemas for the initial tool surface; search_tools and load_skill can add more tools later.",
];

function actorScenario(
  id: PromptScenarioId,
  label: string,
  description: string,
  overlays: PromptBlockDefinition[] = [],
  finalBlocks: PromptBlockDefinition[] = TEXT_FINAL_BLOCKS,
  runtimeBlocks: PromptBlockDefinition[] = CORE_ACTOR_BLOCKS,
  dynamicSections: string[] = [],
): PromptScenarioDefinition {
  return {
    id,
    label,
    family: "actor",
    description,
    blocks: [...runtimeBlocks, ...overlays, ...finalBlocks],
    dynamicSections: [...BASE_DYNAMIC_SECTIONS, ...dynamicSections],
  };
}

const SCENARIOS: Record<PromptScenarioId, PromptScenarioDefinition> = {
  discord: actorScenario("discord", "Discord actor", "Normal text action turn."),
  "scheduled-task": actorScenario(
    "scheduled-task",
    "Scheduled task",
    "Text actor turn started by a scheduled task.",
    [],
    [
      {
        groupId: "surface.scheduled-task.execution-mode",
        phase: "final",
        transportSection: "finalActionInstruction",
        reason: "Scheduled task execution mode replaces the normal visible execution mode.",
        mergeKey: "final-action",
      },
      TEXT_FINAL_BLOCKS[1] as PromptBlockDefinition,
    ],
    CORE_ACTOR_BLOCKS,
    ["Scheduled task input and current-task state.", "update_current_scheduled_task is available on the task tool surface."],
  ),
  "event-watch": actorScenario(
    "event-watch",
    "Event watch",
    "Normal text actor turn with a matched-watch overlay.",
    [{
      groupId: "surface.event-watch.execution-mode",
      phase: "volatile",
      transportSection: "currentContext",
      reason: "Matched watch execution overlay.",
    }],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Matched watch instructions and previous handoff.", "The watch event did not also trigger ordinary attention."],
  ),
  "event-watch-with-trigger": actorScenario(
    "event-watch-with-trigger",
    "Event watch + normal trigger",
    "Matched watch that also caused ordinary actor attention.",
    [{
      groupId: "surface.event-watch.execution-mode",
      phase: "volatile",
      transportSection: "currentContext",
      reason: "Matched watch execution overlay.",
    }],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Matched watch instructions, previous handoff, and ordinary trigger reason."],
  ),
  "ambient-pickup": actorScenario(
    "ambient-pickup",
    "Ambient pickup actor",
    "Normal text actor turn after ambient pickup approval.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Ambient trigger IDs and delayed room history."],
  ),
  "lingering-attention": actorScenario(
    "lingering-attention",
    "Lingering attention actor",
    "Normal text actor turn during a short continuation lease.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Lingering-attention trigger and lease state."],
  ),
  "follow-up": actorScenario(
    "follow-up",
    "Follow-up actor",
    "Normal text actor turn for a rare proactive continuation.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Follow-up anchor and silence-window state."],
  ),
  "ambient-initiative-actor": actorScenario(
    "ambient-initiative-actor",
    "Ambient initiative actor",
    "Normal text actor turn after the initiative evaluator wakes it.",
    [{
      groupId: "surface.ambient-initiative.opportunity",
      phase: "volatile",
      transportSection: "currentTurn",
      renderedTemplate: true,
      reason: "Runtime renders opportunity variables into the synthetic current event.",
    }],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["Opportunity signals, pressure, selected history, and reconsideration state."],
  ),
  "async-image-ready": actorScenario(
    "async-image-ready",
    "Async image ready",
    "Normal text actor turn for a completed image job.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["context/async-image-ready and staged job output.", "Active image-job context when present."],
  ),
  "async-image-failed": actorScenario(
    "async-image-failed",
    "Async image failed",
    "Normal text actor turn for a failed image job.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["context/async-image-failed and job failure details."],
  ),
  "routed-reply": actorScenario(
    "routed-reply",
    "Routed reply",
    "Normal text actor turn that replies to a message routed from another channel.",
    [],
    TEXT_FINAL_BLOCKS,
    CORE_ACTOR_BLOCKS,
    ["context/routed-reply-source and source message identifiers."],
  ),
  "private-life-actor": actorScenario(
    "private-life-actor",
    "Private-life actor",
    "Private opportunity that uses the text runtime with a private-life overlay and boundary.",
    [{
      groupId: "surface.private-life.runtime",
      phase: "volatile",
      transportSection: "responseInstruction",
      reason: "Private-life opportunity policy.",
    }],
    [
      {
        groupId: "surface.private-life.execution-mode",
        phase: "final",
        transportSection: "finalActionInstruction",
        reason: "Private-life execution mode replaces the normal visible execution mode.",
        mergeKey: "final-action",
      },
      {
        groupId: "surface.private-life.final-action",
        phase: "final",
        transportSection: "finalActionInstruction",
        reason: "Private-life action boundary replaces the text action boundary.",
        mergeKey: "final-action",
      },
    ],
    CORE_ACTOR_BLOCKS,
    ["Selected territory, origin, activity mode, action scope, location, and private episode state."],
  ),
  "voice-actor": actorScenario(
    "voice-actor",
    "Live voice actor",
    "Voice-room actor turn with a specialized runtime and action boundary.",
    [],
    [
      TEXT_FINAL_BLOCKS[0] as PromptBlockDefinition,
      {
        groupId: "surface.voice.final-action",
        phase: "final",
        transportSection: "finalActionInstruction",
        reason: "Voice action boundary replaces the text action boundary.",
        mergeKey: "final-action",
      },
    ],
    [
      ...CORE_ACTOR_BLOCKS.filter((block) => block.groupId !== "core.runtime"),
      {
        groupId: "surface.voice.runtime",
        phase: "stable",
        transportSection: "runtime",
        reason: "Voice runtime replaces the default text runtime.",
      },
    ],
    ["Immediate voice exchange, room history, participant state, durable room instructions, and ASR metadata."],
  ),
  "memory-maintenance": {
    id: "memory-maintenance",
    label: "Memory maintenance",
    family: "maintenance",
    description: "Silent memory extraction and deduplication pass.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      { groupId: "pass.memory.execution-mode", phase: "pass", directPlacement: "control", reason: "Memory maintenance control mode." },
      { groupId: "pass.memory.decision", phase: "pass", directPlacement: "control", reason: "Profile memory-update decision policy." },
    ],
    dynamicSections: ["Completed actor evidence, memory candidates, visible-user memory context, and record_memory tool schema.", "The actor transcript can preserve the inherited skill index."],
  },
  "ambient-memory-maintenance": {
    id: "ambient-memory-maintenance",
    label: "Ambient memory maintenance",
    family: "maintenance",
    description: "Periodic silent memory review without a preceding actor reply.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      { groupId: "pass.memory.execution-mode", phase: "pass", directPlacement: "control", reason: "Memory maintenance control mode." },
      { groupId: "pass.memory.ambient-review", phase: "pass", directPlacement: "control", reason: "Periodic ambient-history review policy." },
      { groupId: "pass.memory.decision", phase: "pass", directPlacement: "control", reason: "Profile memory-update decision policy." },
    ],
    dynamicSections: ["Selected ambient history, visible-user memory context, current time, and record_memory tool schema."],
  },
  "relationship-maintenance": {
    id: "relationship-maintenance",
    label: "Relationship maintenance",
    family: "maintenance",
    description: "Silent relationship signal pass.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      {
        groupId: "pass.relationships.context",
        phase: "volatile",
        transportSection: "currentContext",
        renderedTemplate: true,
        reason: "Runtime renders the template with current relationship state.",
      },
      { groupId: "pass.relationships.execution-mode", phase: "pass", directPlacement: "control", reason: "Relationship maintenance control mode." },
      { groupId: "pass.relationships.decision", phase: "pass", directPlacement: "control", reason: "Profile relationship-update decision policy." },
    ],
    dynamicSections: ["Current relationship state, completed actor evidence, and record_relationship tool schema."],
  },
  "inner-thread-maintenance": {
    id: "inner-thread-maintenance",
    label: "Inner-thread maintenance",
    family: "maintenance",
    description: "Silent durable inner-thread maintenance pass.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      { groupId: "pass.inner-threads.execution-mode", phase: "pass", directPlacement: "control", reason: "Inner-thread maintenance control mode." },
      { groupId: "pass.inner-threads.decision", phase: "pass", directPlacement: "control", reason: "Profile inner-thread decision policy." },
    ],
    dynamicSections: ["Completed actor evidence, active inner threads, and record_inner_threads tool schema."],
  },
  "private-life-maintenance": {
    id: "private-life-maintenance",
    label: "Private-life maintenance",
    family: "maintenance",
    description: "Silent private-life episode summary pass.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      { groupId: "surface.private-life.runtime", phase: "stable", transportSection: "runtime", reason: "Private-life runtime appended to the default runtime." },
      { groupId: "pass.private-life.maintenance", phase: "pass", directPlacement: "control", reason: "Private-life episode summary control mode." },
    ],
    dynamicSections: ["Episode actions, private thoughts, visible output, and record_private_life_episode tool schema."],
  },
  "ambient-attention-evaluator-ambient-pickup": {
    id: "ambient-attention-evaluator-ambient-pickup",
    label: "Ambient pickup evaluator",
    family: "evaluator",
    description: "JSON decision pass before an ambient pickup actor turn.",
    blocks: [
      { groupId: "pass.ambient-attention.shared", phase: "pass", directPlacement: "system", reason: "Shared ambient-attention policy." },
      { groupId: "pass.ambient-attention.ambient-pickup", phase: "pass", directPlacement: "system", reason: "Ambient-pickup policy." },
      {
        code: {
          source: "src/ambient/runtime.ts:918",
          text: "Decide whether the configured persona should naturally speak in Discord ambient attention.\n\nUsually choose silence. Do not write the reply text.\n\nReturn only compact JSON with should_reply, reply_probability, confidence, intent, and reason.\n\nreply_probability and confidence must be 0..1. reason should be one short sentence.",
        },
        phase: "pass",
        directPlacement: "system",
        reason: "Evaluator output contract assembled in code.",
      },
    ],
    dynamicSections: ["Candidate kind, trigger IDs, relationship signals, time, and recent channel history."],
  },
  "ambient-attention-evaluator-lingering-attention": {
    id: "ambient-attention-evaluator-lingering-attention",
    label: "Lingering attention evaluator",
    family: "evaluator",
    description: "JSON decision pass before a lingering-attention actor turn.",
    blocks: [
      { groupId: "pass.ambient-attention.shared", phase: "pass", directPlacement: "system", reason: "Shared ambient-attention policy." },
      { groupId: "pass.ambient-attention.lingering-attention", phase: "pass", directPlacement: "system", reason: "Lingering-attention policy." },
      {
        code: {
          source: "src/ambient/runtime.ts:918",
          text: "Decide whether the configured persona should naturally speak in Discord ambient attention.\n\nUsually choose silence. Do not write the reply text.\n\nReturn only compact JSON with should_reply, reply_probability, confidence, intent, and reason.\n\nreply_probability and confidence must be 0..1. reason should be one short sentence.",
        },
        phase: "pass",
        directPlacement: "system",
        reason: "Evaluator output contract assembled in code.",
      },
    ],
    dynamicSections: ["Candidate kind, trigger IDs, relationship signals, time, and recent channel history."],
  },
  "ambient-attention-evaluator-follow-up": {
    id: "ambient-attention-evaluator-follow-up",
    label: "Follow-up evaluator",
    family: "evaluator",
    description: "JSON decision pass before a proactive follow-up actor turn.",
    blocks: [
      { groupId: "pass.ambient-attention.shared", phase: "pass", directPlacement: "system", reason: "Shared ambient-attention policy." },
      { groupId: "pass.ambient-attention.follow-up", phase: "pass", directPlacement: "system", reason: "Follow-up policy." },
      {
        code: {
          source: "src/ambient/runtime.ts:918",
          text: "Decide whether the configured persona should naturally speak in Discord ambient attention.\n\nUsually choose silence. Do not write the reply text.\n\nReturn only compact JSON with should_reply, reply_probability, confidence, intent, and reason.\n\nreply_probability and confidence must be 0..1. reason should be one short sentence.",
        },
        phase: "pass",
        directPlacement: "system",
        reason: "Evaluator output contract assembled in code.",
      },
    ],
    dynamicSections: ["Candidate kind, trigger IDs, relationship signals, time, and recent channel history."],
  },
  "ambient-initiative-evaluator": {
    id: "ambient-initiative-evaluator",
    label: "Ambient initiative evaluator",
    family: "evaluator",
    description: "JSON wake decision before an ambient initiative actor turn.",
    blocks: [
      { groupId: "pass.ambient-initiative.evaluator", phase: "pass", directPlacement: "system", reason: "Ambient initiative wake policy." },
      {
        code: {
          source: "src/ambient/initiative-runtime.ts:551",
          text: "Return only compact JSON with should_wake, wake_probability, confidence, and reason.",
        },
        phase: "pass",
        directPlacement: "system",
        reason: "Evaluator output contract assembled in code.",
      },
    ],
    dynamicSections: ["Current time, opportunity signals, pressure, and recent channel history."],
  },
  "image-reading-fallback": {
    id: "image-reading-fallback",
    label: "Image-reading fallback",
    family: "fallback",
    description: "Dedicated fallback model call when the main model cannot read an image.",
    blocks: [{
      groupId: "pass.image-reading.fallback-system",
      phase: "pass",
      directPlacement: "system",
      reason: "Fallback image-description system prompt.",
    }],
    dynamicSections: ["Image tool result metadata and attached image data."],
  },
  "image-generation": {
    id: "image-generation",
    label: "Image generation",
    family: "generation",
    fixedProvider: "openai-codex",
    description: "Codex Responses call that invokes the image_generation tool.",
    blocks: [{
      code: {
        source: "src/agent/codex-image-prompts.ts",
        text: CODEX_IMAGE_GENERATION_INSTRUCTIONS,
      },
      phase: "stable",
      directPlacement: "system",
      reason: "Stable instructions for the Codex Responses image-generation route.",
    }],
    dynamicSections: [
      "Generated image prompt as the user input.",
      "Image-generation tool schema, forced tool choice, quality, format, and size request fields.",
    ],
  },
  "image-generation-direct": {
    id: "image-generation-direct",
    label: "Direct image generation",
    family: "generation",
    fixedProvider: "openai-codex",
    description: "Direct Codex images/generations fallback call.",
    blocks: [],
    dynamicSections: [
      "Generated image prompt and request parameters. This endpoint receives no system instruction.",
    ],
  },
  "image-edit-direct": {
    id: "image-edit-direct",
    label: "Direct image edit",
    family: "generation",
    fixedProvider: "openai-codex",
    description: "Direct Codex images/edits call used with reference images.",
    blocks: [],
    dynamicSections: [
      "Generated edit prompt, ordered reference images, and request parameters. This endpoint receives no system instruction.",
    ],
  },
  "voice-summary": {
    id: "voice-summary",
    label: "Voice summary",
    family: "maintenance",
    description: "Rolling live-voice summary pass.",
    blocks: [
      {
        code: {
          source: "src/index.ts:1585",
          text: "Maintain a concise rolling summary from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
        },
        phase: "pass",
        directPlacement: "system",
        reason: "Voice summary system prompt assembled in code.",
      },
      {
        code: {
          source: "src/index.ts:1593",
          text: "This is private voice-summary maintenance. Only update_voice_summary is available.",
        },
        phase: "stable",
        transportSection: "runtime",
        reason: "Voice summary runtime instruction assembled in code.",
      },
      {
        code: {
          source: "src/index.ts:1594",
          text: "Call update_voice_summary once with a refreshed 3-6 sentence summary combining the existing summary and new delta. Retry only if the tool reports an error.",
        },
        phase: "pass",
        directPlacement: "control",
        reason: "Voice summary control message assembled in code.",
      },
    ],
    dynamicSections: ["Existing rolling summary, compact voice delta, speaker IDs, and update_voice_summary tool schema."],
  },
  "voice-extraction": {
    id: "voice-extraction",
    label: "Voice extraction",
    family: "maintenance",
    description: "Durable semantic maintenance from compact voice history.",
    blocks: [
      CORE_ACTOR_BLOCKS[0] as PromptBlockDefinition,
      {
        code: {
          source: "src/index.ts:1764",
          text: "Maintain private durable semantic state from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
        },
        phase: "stable",
        transportSection: "system",
        reason: "Voice extraction system addition assembled in code.",
      },
      CORE_ACTOR_BLOCKS[1] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[2] as PromptBlockDefinition,
      CORE_ACTOR_BLOCKS[4] as PromptBlockDefinition,
      { groupId: "pass.semantic-maintenance.execution-mode", phase: "pass", directPlacement: "control", reason: "Shared semantic-maintenance execution mode." },
      { groupId: "pass.memory.decision", phase: "pass", directPlacement: "control", reason: "Profile memory decision policy when memory extraction is enabled." },
      { groupId: "pass.relationships.decision", phase: "pass", directPlacement: "control", reason: "Profile relationship decision policy when relationships are enabled." },
      { groupId: "pass.inner-threads.decision", phase: "pass", directPlacement: "control", reason: "Profile inner-thread decision policy when inner threads are enabled." },
    ],
    dynamicSections: ["Compact voice delta, speaker IDs, default persona mode, feature flags, and maintenance tool schemas."],
  },
};

export interface PromptScenarioSummary {
  id: PromptScenarioId;
  label: string;
  family: PromptScenarioDefinition["family"];
  fixedProvider?: LlmProvider;
  description: string;
}

export interface PromptInspectionDocument {
  order: number;
  groupId: string;
  key: string;
  phase: PromptInspectionPhase;
  status: PromptInspectionStatus;
  reason: string;
  transportSection?: PromptTransportSectionId;
  role?: "system" | "developer" | "user";
  target?: PromptTransportTarget;
  cacheGroup?: string;
  mergeKey?: string;
  source: string;
  layer: PromptInstructionLayer;
  overriddenSources: string[];
  text: string;
  chars: number;
  estimatedTokens: number;
  sha256: string;
}

export interface PromptInspectionCatalogEntry {
  groupId: string;
  key: string;
  status: PromptInspectionStatus;
  source: string;
  layer: PromptInstructionLayer;
  overriddenSources: string[];
  chars: number;
  estimatedTokens: number;
  sha256: string;
  text: string;
}

export interface PromptInspectionBlock {
  order: number;
  id: string;
  phase: PromptInspectionPhase;
  role?: "system" | "developer" | "user";
  target?: PromptTransportTarget;
  cacheGroup?: string;
  mergeKey?: string;
  sourceIds: string[];
  text: string;
}

export interface PromptInspection {
  profile: string;
  provider: LlmProvider;
  transportMode: "legacy-instructions" | "split-input";
  scenario: PromptScenarioSummary;
  scenarios: PromptScenarioSummary[];
  documents: PromptInspectionDocument[];
  blocks: PromptInspectionBlock[];
  dynamicSections: string[];
  catalog: PromptInspectionCatalogEntry[];
  assembled: {
    instructions: string;
    input: Array<{
      role: "system" | "developer" | "user";
      target: PromptTransportTarget;
      cacheGroup?: string;
      phase: PromptInspectionPhase;
      sourceIds: string[];
      text: string;
    }>;
  };
  totals: {
    selectedDocuments: number;
    selectedChars: number;
    estimatedTokens: number;
    catalogDocuments: number;
    overriddenDocuments: number;
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function scenarioSummaries(): PromptScenarioSummary[] {
  return PROMPT_SCENARIO_IDS.map((id) => {
    const scenario = SCENARIOS[id];
    return {
      id,
      label: scenario.label,
      family: scenario.family,
      ...(scenario.fixedProvider !== undefined ? { fixedProvider: scenario.fixedProvider } : {}),
      description: scenario.description,
    };
  });
}

function placementFor(
  provider: LlmProvider,
  transport: PromptTransportConfig,
  block: PromptBlockDefinition,
): {
  role?: "system" | "developer" | "user";
  target?: PromptTransportTarget;
  cacheGroup?: string;
} {
  if (block.transportSection === undefined) {
    if (block.directPlacement === "control") return { role: "user", target: "input" };
    if (block.directPlacement === "system") {
      return {
        role: "system",
        target: provider === "openai-codex" ? "instructions" : "input",
      };
    }
    return {};
  }
  const providerTransport = provider === "openai-codex" ? transport.openaiCodex : transport.openrouter;
  return providerTransport.sections[block.transportSection];
}

function codeDocument(block: PromptBlockDefinition, index: number): PromptDocument | undefined {
  if (block.code === undefined) return undefined;
  return {
    source: block.code.source,
    key: `code-${index + 1}`,
    layer: "code",
    text: block.code.text,
  };
}

function documentsForBlock(
  bundle: PromptBundle,
  block: PromptBlockDefinition,
  index: number,
): { groupId: string; documents: PromptDocument[]; selections: PromptSourceSelection[]; text: string } {
  if (block.groupId !== undefined) {
    const group = bundle.sources.groups[block.groupId];
    if (group === undefined) {
      return { groupId: block.groupId, documents: [], selections: [], text: "" };
    }
    return {
      groupId: block.groupId,
      documents: group.documents,
      selections: group.selections,
      text: group.text,
    };
  }
  const document = codeDocument(block, index);
  if (document === undefined) return { groupId: `code.${index}`, documents: [], selections: [], text: "" };
  return {
    groupId: `code.${index}`,
    documents: [document],
    selections: [{ key: document.key, effective: document, overridden: [] }],
    text: document.text,
  };
}

function selectedGroupStatuses(scenario: PromptScenarioDefinition): Map<string, PromptInspectionStatus> {
  return new Map(scenario.blocks.flatMap((block) => {
    if (block.groupId === undefined) return [];
    return [[block.groupId, block.renderedTemplate === true ? "template" : "included"] as const];
  }));
}

function catalogEntries(
  bundle: PromptBundle,
  selected: ReadonlyMap<string, PromptInspectionStatus>,
): PromptInspectionCatalogEntry[] {
  const entries: PromptInspectionCatalogEntry[] = [];
  const add = (
    groupId: string,
    selection: PromptSourceSelection,
    status: PromptInspectionStatus,
  ): void => {
    entries.push({
      groupId,
      key: selection.key,
      status,
      source: selection.effective.source,
      layer: selection.effective.layer,
      overriddenSources: selection.overridden.map((document) => document.source),
      chars: selection.effective.text.length,
      estimatedTokens: tokenEstimate(selection.effective.text),
      sha256: hash(selection.effective.text),
      text: selection.effective.text,
    });
  };

  for (const [groupId, group] of Object.entries(bundle.sources.groups).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const selectedStatus = selected.get(groupId);
    const status: PromptInspectionStatus = selectedStatus === undefined
      ? "unselected"
      : groupId.startsWith("generated.") ? "generated" : selectedStatus;
    for (const selection of group.selections) add(groupId, selection, status);
  }
  for (const [mapId, sourceMap] of Object.entries(bundle.sources.maps).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    for (const [key, entry] of Object.entries(sourceMap.entries).sort(([a], [b]) => a.localeCompare(b, "en"))) {
      add(mapId, { key, effective: entry.effective, overridden: entry.overridden }, "conditional");
    }
  }
  for (const [skillId, skill] of Object.entries(bundle.runtime.skills.byId).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    for (const document of skill.instructionDocuments) {
      add(`skill.${skillId}`, { key: document.key, effective: document, overridden: [] }, "conditional");
    }
  }
  return entries;
}

function mergeBlocks(blocks: PromptInspectionBlock[]): PromptInspectionBlock[] {
  const merged: PromptInspectionBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (
      previous !== undefined
      && block.mergeKey !== undefined
      && previous.mergeKey === block.mergeKey
      && previous.role === block.role
      && previous.target === block.target
      && previous.cacheGroup === block.cacheGroup
      && previous.phase === block.phase
    ) {
      previous.text = `${previous.text}\n\n${block.text}`;
      previous.sourceIds.push(...block.sourceIds);
      continue;
    }
    merged.push({ ...block, sourceIds: [...block.sourceIds] });
  }
  return merged.map((block, index) => ({ ...block, order: index + 1 }));
}

/** Inspect one prompt scenario without running a model or changing runtime state. */
export function inspectPromptScenario(input: {
  bundle: PromptBundle;
  profile: string;
  scenario: PromptScenarioId;
  provider: LlmProvider;
  transport: PromptTransportConfig;
}): PromptInspection {
  const definition = SCENARIOS[input.scenario];
  const provider = definition.fixedProvider ?? input.provider;
  const providerTransport = provider === "openai-codex"
    ? input.transport.openaiCodex
    : input.transport.openrouter;
  const documents: PromptInspectionDocument[] = [];
  const blocks: PromptInspectionBlock[] = [];

  for (const [blockIndex, block] of definition.blocks.entries()) {
    const loaded = documentsForBlock(input.bundle, block, blockIndex);
    if (loaded.text === "") continue;
    const placement = placementFor(provider, input.transport, block);
    const mergeKey = block.mergeKey
      ?? (block.directPlacement === "control" ? "control" : block.directPlacement === "system" ? "direct-system" : undefined);
    const selectionBySource = new Map(
      loaded.selections.map((selection) => [selection.effective.source, selection]),
    );
    for (const document of loaded.documents) {
      const selection = selectionBySource.get(document.source);
      documents.push({
        order: documents.length + 1,
        groupId: loaded.groupId,
        key: document.key,
        phase: block.phase,
        status: block.renderedTemplate === true
          ? "template"
          : document.layer === "generated" ? "generated" : document.layer === "code" ? "code" : "included",
        reason: block.reason,
        ...(block.transportSection !== undefined ? { transportSection: block.transportSection } : {}),
        ...placement,
        ...(mergeKey !== undefined ? { mergeKey } : {}),
        source: document.source,
        layer: document.layer,
        overriddenSources: selection?.overridden.map((version) => version.source) ?? [],
        text: document.text,
        chars: document.text.length,
        estimatedTokens: tokenEstimate(document.text),
        sha256: hash(document.text),
      });
    }
    if (block.renderedTemplate !== true) {
      blocks.push({
        order: blocks.length + 1,
        id: loaded.groupId,
        phase: block.phase,
        ...placement,
        ...(mergeKey !== undefined ? { mergeKey } : {}),
        sourceIds: loaded.documents.map((document) => document.source),
        text: loaded.text,
      });
    }
  }

  const effectiveBlocks = mergeBlocks(blocks);
  const instructions = provider === "openai-codex"
    ? effectiveBlocks
      .filter((block) => block.target === "instructions")
      .map((block) => block.text)
      .join("\n\n")
    : "";
  const assembledInput = effectiveBlocks
    .filter((block) => provider !== "openai-codex" || block.target !== "instructions")
    .map((block) => ({
      role: block.role ?? (block.phase === "pass" ? "system" : "developer"),
      target: block.target ?? "input",
      ...(block.cacheGroup !== undefined ? { cacheGroup: block.cacheGroup } : {}),
      phase: block.phase,
      sourceIds: block.sourceIds,
      text: block.text,
    }));
  const catalog = catalogEntries(input.bundle, selectedGroupStatuses(definition));
  const selectedChars = documents.reduce((total, document) => total + document.chars, 0);

  return {
    profile: input.profile,
    provider,
    transportMode: providerTransport.mode,
    scenario: {
      id: definition.id,
      label: definition.label,
      family: definition.family,
      ...(definition.fixedProvider !== undefined ? { fixedProvider: definition.fixedProvider } : {}),
      description: definition.description,
    },
    scenarios: scenarioSummaries(),
    documents,
    blocks: effectiveBlocks,
    dynamicSections: definition.dynamicSections,
    catalog,
    assembled: {
      instructions,
      input: assembledInput,
    },
    totals: {
      selectedDocuments: documents.length,
      selectedChars,
      estimatedTokens: tokenEstimate(documents.map((document) => document.text).join("\n\n")),
      catalogDocuments: catalog.length,
      overriddenDocuments: catalog.reduce((total, entry) => total + entry.overriddenSources.length, 0),
    },
  };
}

export function isPromptScenarioId(value: string): value is PromptScenarioId {
  return PROMPT_SCENARIO_IDS.some((id) => id === value);
}

export function promptScenarioSummaries(): PromptScenarioSummary[] {
  return scenarioSummaries();
}
