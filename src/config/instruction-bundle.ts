import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.ts";
import { stripMarkdownComments } from "./instruction-text.ts";
import { validateProfileName } from "./profile.ts";

export type PromptInstructionLayer = "shared" | "profile" | "generated" | "code";

/** One model-visible Markdown instruction file. */
export interface PromptDocument {
  /** Stable path label used for logs and tests. */
  source: string;
  /** Relative key inside its semantic instruction group. */
  key: string;
  /** Layer that supplied this version. */
  layer: PromptInstructionLayer;
  /** Prompt text with a heading guaranteed. */
  text: string;
}

/** Effective instruction document and any lower-layer versions that it replaced. */
export interface PromptSourceSelection {
  key: string;
  effective: PromptDocument;
  overridden: PromptDocument[];
}

/** One ordered, concatenated instruction group. */
export interface PromptSourceGroup {
  id: string;
  documents: PromptDocument[];
  selections: PromptSourceSelection[];
  text: string;
}

/** One keyed instruction template map. */
export interface PromptSourceMapEntry extends PromptSourceSelection {
  text: string;
}

export interface PromptSourceMap {
  id: string;
  entries: Record<string, PromptSourceMapEntry>;
}

/** Complete source trace for the active profile instruction bundle. */
export interface PromptSourceCatalog {
  groups: Record<string, PromptSourceGroup>;
  maps: Record<string, PromptSourceMap>;
}

/** Manifest-backed instruction skill loaded on demand through load_skill. */
export interface PromptSkill {
  /** Stable model-visible skill id. */
  id: string;
  /** Human-readable title used in loaded skill content. */
  title: string;
  /** Compact description shown in the always-loaded skill index. */
  description: string;
  /** Tools that require this skill to be loaded before execution. */
  requiredForTools: string[];
  /** Ordered instruction documents listed by the manifest. */
  instructionDocuments: PromptDocument[];
  /** Deterministically assembled skill instructions returned by load_skill. */
  content: string;
  /** Effective manifest path. */
  manifestSource?: string;
  /** Layer that supplied the effective skill. */
  layer?: PromptInstructionLayer;
  /** Lower-layer manifests replaced by this skill. */
  overriddenManifestSources?: string[];
}

/** Instruction skill registry loaded from the active instruction roots. */
export interface PromptSkillBundle {
  /** Skills keyed by skill id. */
  byId: Record<string, PromptSkill>;
  /** Compact stable prompt section listing available skills. */
  indexPrompt: string;
  /** Alternative required skill ids keyed by tool name. */
  requiredByTool: Record<string, string | string[]>;
}

/** Runtime instruction groups loaded from the active instruction roots. */
export interface RuntimePromptBundle {
  /** Normal visible reply loop runtime instructions. */
  reply: string;
  /** Execution boundary for a long-running background persona agent. */
  backgroundAgent: string;
  /** Final per-turn instruction placed after the current Discord event. */
  finalActionInstruction: string;
  /** Tool descriptions keyed by AgentTool.name. */
  toolDescriptions: Record<string, string>;
  /** Tool parameter descriptions keyed by `${AgentTool.name}/${parameterName}`. */
  toolParameterDescriptions: Record<string, string>;
  /** Context templates keyed by relative path under context without .md. */
  contextTemplates: Record<string, string>;
  /** System prompt for fallback image description when the main model cannot read images. */
  imageDescriptionSystemPrompt: string;
  /** Compact persona/social policies for ambient attention evaluator decisions. */
  ambientAttentionEvaluator: {
    shared: string;
    ambientPickup: string;
    lingeringAttention: string;
    followUp: string;
  };
  /** Compact policy for deciding whether an ambient cognitive opportunity should wake the actor. */
  ambientInitiative: {
    evaluator: string;
  };
  /** Stable policy loaded only into profile-wide private-life actor turns. */
  privateLife?: string;
  /** Relationship engine instruction policies. */
  relationships: {
    context: string;
  };
  /** Specialized live voice prompt loaded only for voice turns. */
  voice?: {
    runtime: string;
    finalActionInstruction: string;
  };
  /** On-demand instruction skills. */
  skills: PromptSkillBundle;
}

/** Full instruction bundle assembled into model prompt sections. */
export interface PromptBundle {
  /** Active system markdown, ordered deterministically by relative path. */
  systemDocuments: PromptDocument[];
  /** Concatenated highest-level stable behavior policy. */
  systemPrompt: string;
  /** Active persona/core markdown, ordered deterministically by relative path. */
  coreDocuments: PromptDocument[];
  /** Concatenated stable persona/style/additional instructions. */
  corePrompt: string;
  /** Runtime instructions scoped separately from persona/style. */
  runtime: RuntimePromptBundle;
  /** Source trace used by prompt diagnostics and inspection. */
  sources: PromptSourceCatalog;
}

interface InstructionRoot {
  path: string;
  layer: PromptInstructionLayer;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function instructionSourceLabel(path: string): string {
  const relativePath = normalizePath(relative(process.cwd(), path));
  return relativePath.startsWith("..") ? normalizePath(path) : relativePath;
}

function titleFromFilename(filename: string): string {
  const stem = filename
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_ ]*/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (stem === "") return "Prompt";
  return stem.replace(/\b\w/g, (char) => char.toUpperCase());
}

function ensureHeading(text: string, filename: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (/^#{1,6}\s+\S/.test(firstLine)) return trimmed;
  return `# ${titleFromFilename(filename)}\n\n${trimmed}`;
}

function renderInstructionDocument(
  path: string,
  key: string,
  layer: PromptInstructionLayer,
  addHeading = true,
): PromptDocument | null {
  const raw = stripMarkdownComments(readFileSync(path, "utf-8"));
  const text = addHeading ? ensureHeading(raw, basename(path)) : raw.trim();
  if (text === "") return null;
  const source = instructionSourceLabel(path);
  return {
    source,
    key,
    layer,
    text,
  };
}

function recursiveMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return dir.endsWith(".md") ? [dir] : [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...recursiveMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function resolveInstructionRoots(profilesDir: string, profile: string): InstructionRoot[] {
  validateProfileName(profile);

  const sharedDir = join(profilesDir, "shared", "instructions");
  const profileDir = join(profilesDir, profile, "instructions");
  if (!existsSync(sharedDir)) {
    throw new Error(`Shared instructions not found at ${sharedDir}`);
  }
  if (!existsSync(profileDir)) {
    throw new Error(`Profile "${profile}" instructions not found at ${profileDir}`);
  }
  return [
    { path: sharedDir, layer: "shared" },
    { path: profileDir, layer: "profile" },
  ];
}

function loadLayeredDocumentGroup(
  instructionRoots: InstructionRoot[],
  relativePath: string,
  log: Logger,
  group: string,
  addHeadings = true,
): PromptSourceGroup {
  const candidates = new Map<string, PromptDocument[]>();
  for (const root of instructionRoots) {
    const baseDir = join(root.path, relativePath);
    for (const path of recursiveMarkdownFiles(baseDir)) {
      const relativeKey = normalizePath(relative(baseDir, path));
      const key = relativeKey === "" ? basename(path) : relativeKey;
      const doc = renderInstructionDocument(path, key, root.layer, addHeadings);
      if (doc === null) continue;
      const versions = candidates.get(key);
      if (versions === undefined) {
        candidates.set(key, [doc]);
      } else {
        versions.push(doc);
      }
      log.info("instruction document loaded", { group, key, source: doc.source, length: doc.text.length });
    }
  }
  const selections = [...candidates.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, versions]): PromptSourceSelection => {
      const effective = versions.at(-1);
      if (effective === undefined) throw new Error(`Instruction group "${group}" has no effective document for "${key}"`);
      return { key, effective, overridden: versions.slice(0, -1) };
    });
  const documents = selections.map((selection) => selection.effective);
  return {
    id: group,
    documents,
    selections,
    text: documents.map((doc) => doc.text).join("\n\n"),
  };
}

function loadRequiredDocumentGroup(
  instructionRoots: InstructionRoot[],
  relativePath: string,
  log: Logger,
  group: string,
  addHeadings = true,
): PromptSourceGroup {
  const loaded = loadLayeredDocumentGroup(instructionRoots, relativePath, log, group, addHeadings);
  if (loaded.documents.length === 0) {
    log.warn("instruction group missing", { group, relativePath });
  }
  return loaded;
}

function loadPromptTextMap(
  instructionRoots: InstructionRoot[],
  relativePath: string,
  log: Logger,
  group: string,
): PromptSourceMap {
  const candidates = new Map<string, PromptDocument[]>();
  for (const root of instructionRoots) {
    const baseDir = join(root.path, relativePath);
    for (const path of recursiveMarkdownFiles(baseDir)) {
      const key = normalizePath(relative(baseDir, path)).replace(/\.md$/i, "");
      const text = stripMarkdownComments(readFileSync(path, "utf-8")).trim();
      if (text === "") continue;
      const document: PromptDocument = {
        source: instructionSourceLabel(path),
        key,
        layer: root.layer,
        text,
      };
      const versions = candidates.get(key);
      if (versions === undefined) {
        candidates.set(key, [document]);
      } else {
        versions.push(document);
      }
      log.info("runtime instruction text loaded", { group, key, source: instructionSourceLabel(path), length: text.length });
    }
  }
  const entries: Record<string, PromptSourceMapEntry> = {};
  for (const [key, versions] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const effective = versions.at(-1);
    if (effective === undefined) continue;
    entries[key] = {
      key,
      effective,
      overridden: versions.slice(0, -1),
      text: effective.text,
    };
  }
  return { id: group, entries };
}

function textValues(sourceMap: PromptSourceMap): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceMap.entries).map(([key, entry]) => [key, entry.text]));
}

function addGroupMapEntry(sourceMap: PromptSourceMap, key: string, group: PromptSourceGroup): void {
  if (group.text === "") return;
  if (group.selections.length !== 1) {
    throw new Error(`Instruction group "${group.id}" must contain exactly one document when used as template "${key}"`);
  }
  const selection = group.selections[0];
  if (selection === undefined) return;
  sourceMap.entries[key] = { ...selection, key, text: group.text };
}

function generatedSourceGroup(id: string, text: string): PromptSourceGroup {
  if (text === "") return { id, documents: [], selections: [], text: "" };
  const document: PromptDocument = {
    source: `generated:${id}`,
    key: id,
    layer: "generated",
    text,
  };
  return {
    id,
    documents: [document],
    selections: [{ key: id, effective: document, overridden: [] }],
    text,
  };
}

interface RawSkillManifest {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  required_for_tools?: unknown;
  instructions?: unknown;
}

interface SkillManifest {
  id: string;
  title: string;
  description: string;
  required_for_tools: string[];
  instructions: string[];
}

function asStringArray(value: unknown, field: string, manifestPath: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Skill manifest ${manifestPath} field "${field}" must be a string array`);
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`Skill manifest ${manifestPath} field "${field}" must contain only non-empty strings`);
    }
    strings.push(item.trim());
  }
  return strings;
}

function parseSkillManifest(path: string): SkillManifest {
  const parsed: unknown = parseYaml(readFileSync(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object") throw new Error(`Skill manifest ${path} must be a YAML object`);
  const raw = parsed as RawSkillManifest;
  if (typeof raw.id !== "string" || raw.id.trim() === "") throw new Error(`Skill manifest ${path} missing id`);
  if (!/^[a-z][a-z0-9_-]*$/.test(raw.id)) throw new Error(`Skill manifest ${path} has invalid id "${raw.id}"`);
  if (typeof raw.title !== "string" || raw.title.trim() === "") throw new Error(`Skill manifest ${path} missing title`);
  if (typeof raw.description !== "string" || raw.description.trim() === "") throw new Error(`Skill manifest ${path} missing description`);
  return {
    id: raw.id.trim(),
    title: raw.title.trim(),
    description: raw.description.trim(),
    required_for_tools: asStringArray(raw.required_for_tools ?? [], "required_for_tools", path),
    instructions: asStringArray(raw.instructions, "instructions", path),
  };
}

function resolveSkillInstructionPath(skillDir: string, relativePath: string, manifestPath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Skill manifest ${manifestPath} instruction "${relativePath}" must be relative`);
  }
  const normalized = normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || normalized.includes(`${sep}..${sep}`)) {
    throw new Error(`Skill manifest ${manifestPath} instruction "${relativePath}" escapes skill directory`);
  }
  if (!normalized.endsWith(".md")) {
    throw new Error(`Skill manifest ${manifestPath} instruction "${relativePath}" must be a markdown file`);
  }
  const path = join(skillDir, normalized);
  if (!existsSync(path)) throw new Error(`Skill manifest ${manifestPath} references missing instruction "${relativePath}"`);
  return path;
}

function renderSkillIndex(skills: PromptSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "## Skills",
    "Before taking a private action that requires a skill, call load_skill for that skill.",
    "Available skills:",
    ...skills.map((skill) => {
      const required = skill.requiredForTools.length > 0
        ? ` Required before: ${skill.requiredForTools.join(", ")}.`
        : "";
      return `- ${skill.id}: ${skill.description}${required}`;
    }),
  ].join("\n");
}

function loadInstructionSkills(instructionRoots: InstructionRoot[], log: Logger): PromptSkillBundle {
  const byId: Record<string, PromptSkill> = {};
  for (const root of instructionRoots) {
    const skillsDir = join(root.path, "skills");
    if (!existsSync(skillsDir)) continue;
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    const rootIds = new Set<string>();
    for (const entry of skillDirs) {
      const skillDir = join(skillsDir, entry.name);
      const manifestPath = join(skillDir, "skill.yaml");
      if (!existsSync(manifestPath)) throw new Error(`Skill directory ${skillDir} missing skill.yaml`);
      const manifest = parseSkillManifest(manifestPath);
      if (rootIds.has(manifest.id)) throw new Error(`Duplicate instruction skill id "${manifest.id}" in ${skillsDir}`);
      rootIds.add(manifest.id);

      const instructionDocuments = manifest.instructions.map((instructionPath) => {
        const path = resolveSkillInstructionPath(skillDir, instructionPath, manifestPath);
        const doc = renderInstructionDocument(path, instructionPath, root.layer);
        if (doc === null) throw new Error(`Skill instruction ${path} is empty`);
        return doc;
      });
      const content = [`# Skill: ${manifest.title}`, ...instructionDocuments.map((doc) => doc.text)].join("\n\n");
      const previous = byId[manifest.id];
      const skill: PromptSkill = {
        id: manifest.id,
        title: manifest.title,
        description: manifest.description,
        requiredForTools: manifest.required_for_tools,
        instructionDocuments,
        content,
        manifestSource: instructionSourceLabel(manifestPath),
        layer: root.layer,
        overriddenManifestSources: previous?.manifestSource !== undefined
          ? [...(previous.overriddenManifestSources ?? []), previous.manifestSource]
          : [],
      };
      byId[skill.id] = skill;
      log.info("instruction skill loaded", {
        id: skill.id,
        source: instructionSourceLabel(manifestPath),
        instructions: skill.instructionDocuments.length,
        length: skill.content.length,
      });
    }
  }

  const orderedSkills = Object.values(byId).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const requiredByTool: Record<string, string | string[]> = {};
  for (const skill of orderedSkills) {
    for (const toolName of skill.requiredForTools) {
      const previous = requiredByTool[toolName];
      if (previous === undefined) requiredByTool[toolName] = skill.id;
      else if (typeof previous === "string" && previous !== skill.id) requiredByTool[toolName] = [previous, skill.id];
      else if (Array.isArray(previous) && !previous.includes(skill.id)) previous.push(skill.id);
    }
  }
  return {
    byId,
    indexPrompt: renderSkillIndex(orderedSkills),
    requiredByTool,
  };
}

/** Load shared instructions plus one profile overlay. */
export function loadInstructionBundle(profilesDir: string, profile: string, log: Logger): PromptBundle {
  const instructionRoots = resolveInstructionRoots(profilesDir, profile);
  const skills = loadInstructionSkills(instructionRoots, log);
  const groups: Record<string, PromptSourceGroup> = {
    "core.system": loadRequiredDocumentGroup(instructionRoots, join("core", "00-system"), log, "core.system"),
    "core.persona": loadRequiredDocumentGroup(instructionRoots, join("core", "10-persona"), log, "core.persona"),
    "core.style": loadRequiredDocumentGroup(instructionRoots, join("core", "20-style"), log, "core.style"),
    "core.runtime": loadRequiredDocumentGroup(instructionRoots, join("core", "30-runtime"), log, "core.runtime"),
    "surface.text.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "text", "execution-mode.md"),
      log,
      "surface.text.execution-mode",
      false,
    ),
    "surface.text.final-action": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "text", "final-action"),
      log,
      "surface.text.final-action",
    ),
    "surface.background-agent.runtime": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "background-agent", "runtime.md"),
      log,
      "surface.background-agent.runtime",
      false,
    ),
    "surface.scheduled-task.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "scheduled-task", "execution-mode.md"),
      log,
      "surface.scheduled-task.execution-mode",
      false,
    ),
    "surface.event-watch.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "event-watch", "execution-mode.md"),
      log,
      "surface.event-watch.execution-mode",
      false,
    ),
    "surface.ambient-initiative.opportunity": loadRequiredDocumentGroup(
      instructionRoots,
      join("surfaces", "ambient-initiative", "opportunity.md"),
      log,
      "surface.ambient-initiative.opportunity",
      false,
    ),
    "surface.private-life.runtime": loadLayeredDocumentGroup(
      instructionRoots,
      join("surfaces", "private-life", "runtime"),
      log,
      "surface.private-life.runtime",
    ),
    "surface.private-life.execution-mode": loadLayeredDocumentGroup(
      instructionRoots,
      join("surfaces", "private-life", "execution-mode.md"),
      log,
      "surface.private-life.execution-mode",
      false,
    ),
    "surface.private-life.final-action": loadLayeredDocumentGroup(
      instructionRoots,
      join("surfaces", "private-life", "final-action.md"),
      log,
      "surface.private-life.final-action",
      false,
    ),
    "surface.voice.runtime": loadLayeredDocumentGroup(
      instructionRoots,
      join("surfaces", "voice", "runtime"),
      log,
      "surface.voice.runtime",
    ),
    "surface.voice.final-action": loadLayeredDocumentGroup(
      instructionRoots,
      join("surfaces", "voice", "final-action"),
      log,
      "surface.voice.final-action",
    ),
    "pass.memory.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "memory", "execution-mode.md"),
      log,
      "pass.memory.execution-mode",
      false,
    ),
    "pass.memory.decision": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "memory", "decision.md"),
      log,
      "pass.memory.decision",
      false,
    ),
    "pass.memory.ambient-review": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "memory", "ambient-review.md"),
      log,
      "pass.memory.ambient-review",
      false,
    ),
    "pass.relationships.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "relationships", "execution-mode.md"),
      log,
      "pass.relationships.execution-mode",
      false,
    ),
    "pass.relationships.decision": loadLayeredDocumentGroup(
      instructionRoots,
      join("passes", "relationships", "decision.md"),
      log,
      "pass.relationships.decision",
      false,
    ),
    "pass.relationships.context": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "relationships", "context"),
      log,
      "pass.relationships.context",
    ),
    "pass.inner-threads.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "inner-threads", "execution-mode.md"),
      log,
      "pass.inner-threads.execution-mode",
      false,
    ),
    "pass.inner-threads.decision": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "inner-threads", "decision.md"),
      log,
      "pass.inner-threads.decision",
      false,
    ),
    "pass.semantic-maintenance.execution-mode": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "semantic-maintenance", "execution-mode.md"),
      log,
      "pass.semantic-maintenance.execution-mode",
      false,
    ),
    "pass.private-life.maintenance": loadLayeredDocumentGroup(
      instructionRoots,
      join("passes", "private-life", "maintenance.md"),
      log,
      "pass.private-life.maintenance",
      false,
    ),
    "pass.image-reading.fallback-system": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "image-reading", "fallback-system"),
      log,
      "pass.image-reading.fallback-system",
    ),
    "pass.ambient-attention.shared": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "ambient-attention", "evaluator", "shared"),
      log,
      "pass.ambient-attention.shared",
    ),
    "pass.ambient-attention.ambient-pickup": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "ambient-attention", "evaluator", "ambient-pickup"),
      log,
      "pass.ambient-attention.ambient-pickup",
    ),
    "pass.ambient-attention.lingering-attention": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "ambient-attention", "evaluator", "lingering-attention"),
      log,
      "pass.ambient-attention.lingering-attention",
    ),
    "pass.ambient-attention.follow-up": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "ambient-attention", "evaluator", "follow-up"),
      log,
      "pass.ambient-attention.follow-up",
    ),
    "pass.ambient-initiative.evaluator": loadRequiredDocumentGroup(
      instructionRoots,
      join("passes", "ambient-initiative", "evaluator", "generic"),
      log,
      "pass.ambient-initiative.evaluator",
    ),
    "generated.skills-index": generatedSourceGroup("skills-index", skills.indexPrompt),
  };

  const contextTemplates = loadPromptTextMap(
    instructionRoots,
    "context",
    log,
    "context",
  );
  const contextGroups: ReadonlyArray<readonly [string, string]> = [
    ["visible-reply-execution-mode", "surface.text.execution-mode"],
    ["scheduled-task-execution-mode", "surface.scheduled-task.execution-mode"],
    ["event-watch-execution-mode", "surface.event-watch.execution-mode"],
    ["ambient-initiative-opportunity", "surface.ambient-initiative.opportunity"],
    ["private-life-actor-turn", "surface.private-life.execution-mode"],
    ["private-life-action-boundary", "surface.private-life.final-action"],
    ["memory-maintenance-execution-mode", "pass.memory.execution-mode"],
    ["memory-pass-decision", "pass.memory.decision"],
    ["memory-pass-ambient-review", "pass.memory.ambient-review"],
    ["relationship-maintenance-execution-mode", "pass.relationships.execution-mode"],
    ["relationship-pass-decision", "pass.relationships.decision"],
    ["inner-thread-maintenance-execution-mode", "pass.inner-threads.execution-mode"],
    ["inner-thread-pass-decision", "pass.inner-threads.decision"],
    ["semantic-maintenance-execution-mode", "pass.semantic-maintenance.execution-mode"],
    ["private-life-maintenance", "pass.private-life.maintenance"],
  ];
  for (const [key, groupId] of contextGroups) {
    const group = groups[groupId];
    if (group !== undefined) addGroupMapEntry(contextTemplates, key, group);
  }

  const toolDescriptions = loadPromptTextMap(
    instructionRoots,
    join("tools", "descriptions"),
    log,
    "tools.descriptions",
  );
  const toolParameterDescriptions = loadPromptTextMap(
    instructionRoots,
    join("tools", "parameters"),
    log,
    "tools.parameters",
  );
  const systemGroup = groups["core.system"];
  const personaGroup = groups["core.persona"];
  const styleGroup = groups["core.style"];
  const runtimeGroup = groups["core.runtime"];
  const finalActionGroup = groups["surface.text.final-action"];
  if (
    systemGroup === undefined
    || personaGroup === undefined
    || styleGroup === undefined
    || runtimeGroup === undefined
    || finalActionGroup === undefined
  ) {
    throw new Error("Core instruction groups were not loaded");
  }
  const coreDocuments = [...personaGroup.documents, ...styleGroup.documents];

  return {
    systemDocuments: systemGroup.documents,
    systemPrompt: systemGroup.text,
    coreDocuments,
    corePrompt: [personaGroup.text, styleGroup.text].filter((text) => text !== "").join("\n\n"),
    runtime: {
      reply: runtimeGroup.text,
      backgroundAgent: groups["surface.background-agent.runtime"]?.text ?? "",
      finalActionInstruction: finalActionGroup.text,
      toolDescriptions: textValues(toolDescriptions),
      toolParameterDescriptions: textValues(toolParameterDescriptions),
      contextTemplates: textValues(contextTemplates),
      imageDescriptionSystemPrompt: groups["pass.image-reading.fallback-system"]?.text ?? "",
      ambientAttentionEvaluator: {
        shared: groups["pass.ambient-attention.shared"]?.text ?? "",
        ambientPickup: groups["pass.ambient-attention.ambient-pickup"]?.text ?? "",
        lingeringAttention: groups["pass.ambient-attention.lingering-attention"]?.text ?? "",
        followUp: groups["pass.ambient-attention.follow-up"]?.text ?? "",
      },
      ambientInitiative: {
        evaluator: groups["pass.ambient-initiative.evaluator"]?.text ?? "",
      },
      privateLife: groups["surface.private-life.runtime"]?.text ?? "",
      relationships: {
        context: groups["pass.relationships.context"]?.text ?? "",
      },
      voice: {
        runtime: groups["surface.voice.runtime"]?.text ?? "",
        finalActionInstruction: groups["surface.voice.final-action"]?.text ?? "",
      },
      skills,
    },
    sources: {
      groups,
      maps: {
        context: contextTemplates,
        "tools.descriptions": toolDescriptions,
        "tools.parameters": toolParameterDescriptions,
      },
    },
  };
}
