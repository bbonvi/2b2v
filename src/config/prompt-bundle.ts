import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.ts";

/** One markdown prompt file loaded into the stable system prompt. */
export interface PromptDocument {
  /** Stable path label used for logs and tests. */
  source: string;
  /** Prompt text with a heading guaranteed. */
  text: string;
}

/** Manifest-backed prompt skill loaded on demand through load_skill. */
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

/** Prompt skill registry loaded from prompts/skills. */
export interface PromptSkillBundle {
  /** Skills keyed by skill id. */
  byId: Record<string, PromptSkill>;
  /** Compact stable prompt section listing available skills. */
  indexPrompt: string;
  /** Required skill id keyed by tool name. */
  requiredByTool: Record<string, string>;
}

/** Runtime prompt groups loaded from prompts/runtime. */
export interface RuntimePromptBundle {
  /** Normal visible reply loop runtime instructions. */
  reply: string;
  /** Final per-turn instruction placed after the current Discord event. */
  finalActionInstruction: string;
  /** Silent memory pass control instructions. */
  memoryPass: string;
  /** Shared memory-selection policy for memory passes and record_memory. */
  memoryPolicy: string;
  /** Tool descriptions keyed by AgentTool.name. */
  toolDescriptions: Record<string, string>;
  /** Tool parameter descriptions keyed by `${AgentTool.name}/${parameterName}`. */
  toolParameterDescriptions: Record<string, string>;
  /** Runtime context templates keyed by file path under prompts/runtime/context without .md. */
  contextTemplates: Record<string, string>;
  /** Memory context text keyed by file path under prompts/runtime/memory/context without .md. */
  memoryContextTemplates: Record<string, string>;
  /** System prompt for fallback image description when the main model cannot read images. */
  imageDescriptionSystemPrompt: string;
  /** Compact persona/social policy for ambient attention evaluator decisions. */
  ambientAttentionEvaluator: string;
  /** On-demand prompt skills. */
  skills: PromptSkillBundle;
}

/** Full prompt bundle used by the Discord agent. */
export interface PromptBundle {
  /** Markdown files from prompts/system/**, ordered deterministically by relative path. */
  systemDocuments: PromptDocument[];
  /** Concatenated highest-level stable behavior policy. */
  systemPrompt: string;
  /** Markdown files from prompts/core/**, ordered deterministically by relative path. */
  coreDocuments: PromptDocument[];
  /** Concatenated stable persona/style/additional instructions. */
  corePrompt: string;
  /** Runtime instructions scoped separately from persona/style. */
  runtime: RuntimePromptBundle;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function promptSourceLabel(path: string): string {
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

function renderPromptDocument(path: string): PromptDocument | null {
  const raw = readFileSync(path, "utf-8");
  const text = ensureHeading(raw, basename(path));
  if (text === "") return null;
  const source = promptSourceLabel(path);
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

function loadDocuments(paths: string[], log: Logger, group: string): PromptDocument[] {
  const docs: PromptDocument[] = [];
  for (const path of paths) {
    const doc = renderPromptDocument(path);
    if (doc === null) continue;
    log.info("prompt document loaded", { group, source: doc.source, length: doc.text.length });
    docs.push(doc);
  }
  return docs;
}

function loadRuntimeFile(promptDir: string, relativePath: string, log: Logger): string {
  const path = join(promptDir, "runtime", relativePath);
  if (!existsSync(path)) {
    log.warn("runtime prompt file missing", { path });
    return "";
  }
  const doc = renderPromptDocument(path);
  if (doc === null) return "";
  log.info("runtime prompt document loaded", { source: doc.source, length: doc.text.length });
  return doc.text;
}

function loadRuntimeDocuments(promptDir: string, relativePath: string, log: Logger, group: string): string {
  const docs = loadDocuments(
    recursiveMarkdownFiles(join(promptDir, "runtime", relativePath)),
    log,
    group,
  );
  if (docs.length > 0) return docs.map((doc) => doc.text).join("\n\n");
  return loadRuntimeFile(promptDir, `${relativePath}.md`, log);
}

function loadRuntimeTextMap(promptDir: string, relativePath: string, log: Logger, group: string): Record<string, string> {
  const baseDir = join(promptDir, "runtime", relativePath);
  const entries: Record<string, string> = {};
  for (const path of recursiveMarkdownFiles(baseDir)) {
    const key = normalizePath(relative(baseDir, path)).replace(/\.md$/i, "");
    if (entries[key] !== undefined) {
      throw new Error(`Duplicate runtime prompt key "${key}" in ${baseDir}`);
    }
    const text = readFileSync(path, "utf-8").trim();
    if (text === "") continue;
    entries[key] = text;
    log.info("runtime prompt text loaded", { group, key, source: promptSourceLabel(path), length: text.length });
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
    "Before 2B takes a private action that requires a skill, call load_skill for that skill.",
    "Available skills:",
    ...skills.map((skill) => {
      const required = skill.requiredForTools.length > 0
        ? ` Required before: ${skill.requiredForTools.join(", ")}.`
        : "";
      return `- ${skill.id}: ${skill.description}${required}`;
    }),
  ].join("\n");
}

function loadPromptSkills(promptDir: string, log: Logger): PromptSkillBundle {
  const skillsDir = join(promptDir, "skills");
  if (!existsSync(skillsDir)) {
    return { byId: {}, indexPrompt: "", requiredByTool: {} };
  }

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const byId: Record<string, PromptSkill> = {};
  const requiredByTool: Record<string, string> = {};
  const orderedSkills: PromptSkill[] = [];

  for (const entry of skillDirs) {
    const skillDir = join(skillsDir, entry.name);
    const manifestPath = join(skillDir, "skill.yaml");
    if (!existsSync(manifestPath)) throw new Error(`Skill directory ${skillDir} missing skill.yaml`);
    const manifest = parseSkillManifest(manifestPath);
    if (byId[manifest.id] !== undefined) throw new Error(`Duplicate prompt skill id "${manifest.id}"`);

    const instructionDocuments = manifest.instructions.map((instructionPath) => {
      const path = resolveSkillInstructionPath(skillDir, instructionPath, manifestPath);
      const doc = renderPromptDocument(path);
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
    for (const toolName of skill.requiredForTools) {
      const previous = requiredByTool[toolName];
      if (previous !== undefined && previous !== skill.id) {
        throw new Error(`Tool "${toolName}" requires multiple skills: "${previous}" and "${skill.id}"`);
      }
      requiredByTool[toolName] = skill.id;
    }
    byId[skill.id] = skill;
    orderedSkills.push(skill);
    log.info("prompt skill loaded", {
      id: skill.id,
      source: promptSourceLabel(manifestPath),
      instructions: skill.instructionDocuments.length,
      length: skill.content.length,
    });
  }

  return {
    byId,
    indexPrompt: renderSkillIndex(orderedSkills),
    requiredByTool,
  };
}

/** Load all prompt markdown deterministically from the prompt directory. */
export function loadPromptBundle(promptDir: string, log: Logger): PromptBundle {
  const systemDocuments = loadDocuments(
    recursiveMarkdownFiles(join(promptDir, "system")),
    log,
    "system",
  );
  const coreDocuments = loadDocuments(
    recursiveMarkdownFiles(join(promptDir, "core")),
    log,
    "core",
  );
  const runtimeReplyDocuments = loadDocuments(
    recursiveMarkdownFiles(join(promptDir, "runtime", "reply")),
    log,
    "runtime.reply",
  );
  const skills = loadPromptSkills(promptDir, log);
  return {
    systemDocuments,
    systemPrompt: systemDocuments.map((doc) => doc.text).join("\n\n"),
    coreDocuments,
    corePrompt: coreDocuments.map((doc) => doc.text).join("\n\n"),
    runtime: {
      reply: runtimeReplyDocuments.map((doc) => doc.text).join("\n\n"),
      finalActionInstruction: loadRuntimeDocuments(promptDir, "final-action-instruction", log, "runtime.final-action-instruction"),
      memoryPass: loadRuntimeDocuments(promptDir, "memory/pass", log, "runtime.memory.pass"),
      memoryPolicy: loadRuntimeDocuments(promptDir, "memory/policy", log, "runtime.memory.policy"),
      toolDescriptions: loadRuntimeTextMap(promptDir, "tools", log, "runtime.tools"),
      toolParameterDescriptions: loadRuntimeTextMap(promptDir, "tool-parameters", log, "runtime.tool-parameters"),
      contextTemplates: loadRuntimeTextMap(promptDir, "context", log, "runtime.context"),
      memoryContextTemplates: loadRuntimeTextMap(promptDir, "memory/context", log, "runtime.memory.context"),
      imageDescriptionSystemPrompt: loadRuntimeDocuments(promptDir, "image-reading/fallback-system", log, "runtime.image-reading"),
      ambientAttentionEvaluator: loadRuntimeDocuments(promptDir, "ambient-attention/evaluator", log, "runtime.ambient-attention.evaluator"),
      skills,
    },
  };
}
