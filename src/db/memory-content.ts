/** Normalize model-supplied memory text before it is stored or shown. */
export function sanitizeMemoryContent(content: string): string {
  let normalized = content.trim();
  for (;;) {
    const before = normalized;
    normalized = normalized
      .replace(/^In guild\s+\S+:\s*/i, "")
      .replace(/^-?\s*\d+\s+\[(?:@[^\]]+|user:[^\]]+|guild:[^\]]+|self)\]\s+(?:\[[0-9.]+\]\s+)?\[[a-z_]+\]\s*/i, "")
      .trim();
    if (normalized === before) return normalized;
  }
}
