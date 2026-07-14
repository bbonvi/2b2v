import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import { renderPromptTemplate, type PromptTemplateVariables } from "../config/prompt-template.ts";

export type ToolPromptVariables = Record<string, PromptTemplateVariables>;

interface MutableSchema {
  description?: string;
  properties?: Record<string, MutableSchema>;
}

function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSchema(entry));
  }
  if (value === null || typeof value !== "object") return value;

  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) {
      descriptor.value = cloneSchema(descriptor.value);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

function renderToolTemplate(
  template: string,
  toolName: string,
  variablesByTool: ToolPromptVariables,
): string {
  return renderPromptTemplate(template, variablesByTool[toolName] ?? {});
}

function applyParameterDescriptions(
  tool: AgentTool,
  runtimePrompts: RuntimePromptBundle,
  variablesByTool: ToolPromptVariables,
): void {
  const schema = tool.parameters as MutableSchema | undefined;
  const properties = schema?.properties;
  if (properties === undefined) return;

  for (const [paramName, paramSchema] of Object.entries(properties)) {
    const key = `${tool.name}/${paramName}`;
    const template = runtimePrompts.toolParameterDescriptions[key];
    if (template === undefined) continue;
    paramSchema.description = renderToolTemplate(template, tool.name, variablesByTool);
  }
}

/** Apply external runtime descriptions to tools after construction. */
export function applyRuntimeToolPrompts(
  tools: AgentTool[],
  runtimePrompts: RuntimePromptBundle,
  variablesByTool: ToolPromptVariables = {},
): AgentTool[] {
  return tools.map((tool) => {
    const patched: AgentTool = {
      ...tool,
      parameters: cloneSchema(tool.parameters) as AgentTool["parameters"],
    };
    const template = runtimePrompts.toolDescriptions[patched.name];
    if (template !== undefined) {
      patched.description = renderToolTemplate(template, patched.name, variablesByTool);
    }
    applyParameterDescriptions(patched, runtimePrompts, variablesByTool);
    return patched;
  });
}
