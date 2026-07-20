/** Remove closed Markdown HTML comments from imported instruction text. */
export function stripMarkdownComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}
