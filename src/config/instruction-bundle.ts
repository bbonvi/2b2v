import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.ts";
import { stripMarkdownComments } from "./instruction-text.ts";
import { validateProfileName } from "./profile.ts";

/** One markdown instruction file loaded into the stable system prompt. */
export interface PromptDocument {
  /** Stable path label used for logs and tests. */
  source: string;
  /** Prompt text with a heading guaranteed. */
  text: string;
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
}

/** Instruction skill registry loaded from the active instruction roots. */
export interface PromptSkillBundle {
  /** Skills keyed by skill id. */
  byId: Record<string, PromptSkill>;
  /** Compact stable prompt section listing available skills. */
  indexPrompt: string;
  /** Required skill id keyed by tool name. */
  requiredByTool: Record<string, string>;
}

/** Runtime instruction groups loaded from the active instruction roots. */
export interface RuntimePromptBundle {
  /** Normal visible reply loop runtime instructions. */
  reply: string;
  /** Final per-turn instruction placed after the current Discord event. */
  finalActionInstruction: string;
  /** Tool descriptions keyed by AgentTool.name. */
  toolDescriptions: Record<string, string>;
  /** Tool parameter descriptions keyed by `${AgentTool.name}/${parameterName}`. */
  toolParameterDescriptions: Record<string, string>;
  /** Runtime context templates keyed by relative path under runtime/context without .md. */
  contextTemplates: Record<string, string>;
  /** Memory context text keyed by relative path under runtime/memory/context without .md. */
  memoryContextTemplates: Record<string, string>;
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

function renderInstructionDocument(path: string): PromptDocument | null {
  const raw = stripMarkdownComments(readFileSync(path, "utf-8"));
  const text = ensureHeading(raw, basename(path));
  if (text === "") return null;
  const source = instructionSourceLabel(path);
  return {
    source,
    text,
  };
}

function recursiveMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
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

function resolveInstructionRoots(profilesDir: string, profile: string): string[] {
  validateProfileName(profile);

  const sharedDir = join(profilesDir, "shared", "instructions");
  const profileDir = join(profilesDir, profile, "instructions");
  if (!existsSync(sharedDir)) {
    throw new Error(`Shared instructions not found at ${sharedDir}`);
  }
  if (!existsSync(profileDir)) {
    throw new Error(`Profile "${profile}" instructions not found at ${profileDir}`);
  }
  return [sharedDir, profileDir];
}

function loadLayeredDocuments(instructionRoots: string[], relativePath: string, log: Logger, group: string): PromptDocument[] {
  const byRelativePath = new Map<string, PromptDocument>();
  for (const root of instructionRoots) {
    const baseDir = join(root, relativePath);
    for (const path of recursiveMarkdownFiles(baseDir)) {
      const doc = renderInstructionDocument(path);
      if (doc === null) continue;
      const key = normalizePath(relative(baseDir, path));
      byRelativePath.set(key, doc);
      log.info("instruction document loaded", { group, key, source: doc.source, length: doc.text.length });
    }
  }
  return [...byRelativePath.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([, doc]) => doc);
}

function loadRuntimeDocuments(instructionRoots: string[], relativePath: string, log: Logger, group: string): string {
  const docs = loadLayeredDocuments(instructionRoots, join("runtime", relativePath), log, group);
  if (docs.length === 0) {
    log.warn("runtime instruction file missing", { relativePath });
  }
  return docs.map((doc) => doc.text).join("\n\n");
}

function loadRuntimeTextMap(instructionRoots: string[], relativePath: string, log: Logger, group: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const root of instructionRoots) {
    const baseDir = join(root, "runtime", relativePath);
    for (const path of recursiveMarkdownFiles(baseDir)) {
      const key = normalizePath(relative(baseDir, path)).replace(/\.md$/i, "");
      const text = stripMarkdownComments(readFileSync(path, "utf-8")).trim();
      if (text === "") continue;
      entries[key] = text;
      log.info("runtime instruction text loaded", { group, key, source: instructionSourceLabel(path), length: text.length });
    }
  }
  return entries;
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

function loadInstructionSkills(instructionRoots: string[], log: Logger): PromptSkillBundle {
  const byId: Record<string, PromptSkill> = {};
  for (const root of instructionRoots) {
    const skillsDir = join(root, "skills");
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
        const doc = renderInstructionDocument(path);
        if (doc === null) throw new Error(`Skill instruction ${path} is empty`);
        return doc;
      });
      const content = [`# Skill: ${manifest.title}`, ...instructionDocuments.map((doc) => doc.text)].join("\n\n");
      const skill: PromptSkill = {
        id: manifest.id,
        title: manifest.title,
        description: manifest.description,
        requiredForTools: manifest.required_for_tools,
        instructionDocuments,
        content,
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
  const requiredByTool: Record<string, string> = {};
  for (const skill of orderedSkills) {
    for (const toolName of skill.requiredForTools) {
      const previous = requiredByTool[toolName];
      if (previous !== undefined && previous !== skill.id) {
        throw new Error(`Tool "${toolName}" requires multiple skills: "${previous}" and "${skill.id}"`);
      }
      requiredByTool[toolName] = skill.id;
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
  const systemDocuments = loadLayeredDocuments(instructionRoots, "system", log, "system");
  const coreDocuments = loadLayeredDocuments(instructionRoots, "core", log, "core");
  const runtimeReplyDocuments = loadLayeredDocuments(instructionRoots, join("runtime", "reply"), log, "runtime.reply");
  const skills = loadInstructionSkills(instructionRoots, log);
  return {
    systemDocuments,
    systemPrompt: systemDocuments.map((doc) => doc.text).join("\n\n"),
    coreDocuments,
    corePrompt: coreDocuments.map((doc) => doc.text).join("\n\n"),
    runtime: {
      reply: runtimeReplyDocuments.map((doc) => doc.text).join("\n\n"),
      finalActionInstruction: loadRuntimeDocuments(instructionRoots, "final-action-instruction", log, "runtime.final-action-instruction"),
      toolDescriptions: loadRuntimeTextMap(instructionRoots, "tools", log, "runtime.tools"),
      toolParameterDescriptions: loadRuntimeTextMap(instructionRoots, "tool-parameters", log, "runtime.tool-parameters"),
      contextTemplates: loadRuntimeTextMap(instructionRoots, "context", log, "runtime.context"),
      memoryContextTemplates: loadRuntimeTextMap(instructionRoots, "memory/context", log, "runtime.memory.context"),
      imageDescriptionSystemPrompt: loadRuntimeDocuments(instructionRoots, "image-reading/fallback-system", log, "runtime.image-reading"),
      ambientAttentionEvaluator: {
        shared: loadRuntimeDocuments(instructionRoots, "ambient-attention/evaluator/shared", log, "runtime.ambient-attention.evaluator.shared"),
        ambientPickup: loadRuntimeDocuments(instructionRoots, "ambient-attention/evaluator/ambient-pickup", log, "runtime.ambient-attention.evaluator.ambient-pickup"),
        lingeringAttention: loadRuntimeDocuments(instructionRoots, "ambient-attention/evaluator/lingering-attention", log, "runtime.ambient-attention.evaluator.lingering-attention"),
        followUp: loadRuntimeDocuments(instructionRoots, "ambient-attention/evaluator/follow-up", log, "runtime.ambient-attention.evaluator.follow-up"),
      },
      ambientInitiative: {
        evaluator: loadRuntimeDocuments(
          instructionRoots,
          "ambient-initiative/evaluator/generic",
          log,
          "runtime.ambient-initiative.evaluator.generic",
        ),
      },
      relationships: {
        context: loadRuntimeDocuments(instructionRoots, "relationships/context", log, "runtime.relationships.context"),
      },
      voice: {
        runtime: loadLayeredDocuments(instructionRoots, join("runtime", "voice", "reply"), log, "runtime.voice.reply")
          .map((doc) => doc.text)
          .join("\n\n"),
        finalActionInstruction: loadLayeredDocuments(instructionRoots, join("runtime", "voice", "final-action"), log, "runtime.voice.final-action")
          .map((doc) => doc.text)
          .join("\n\n"),
      },
      skills,
    },
  };
}
