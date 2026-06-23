export type PromptTemplateValue = string | number | boolean;
export type PromptTemplateVariables = Record<string, PromptTemplateValue | undefined>;

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Render a deterministic prompt template with explicit scalar variables. */
export function renderPromptTemplate(
  template: string,
  variables: PromptTemplateVariables = {},
): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Missing prompt template variable: ${key}`);
    }
    return String(value);
  });
}
