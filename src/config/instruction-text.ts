/** Remove closed Markdown HTML comments from imported instruction text. */
export function stripMarkdownComments(text: string): string {
  return text
    .replace(/^[\t ]*<!--(?:(?!-->)[\s\S])*-->[\t ]*(?:\r?\n|$)/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}
