import type { DiffReviewDraft } from "./review-types";

/**
 * Renders the pending line notes as one Markdown comment.
 *
 * Mentions follow the backend contract: `[@Label](mention://agent/<uuid>)`.
 * An `agent` mention enqueues a run for that agent, which is how the author of
 * the reviewed change gets pinged.
 */
export function composeReviewMarkdown(
  drafts: DiffReviewDraft[],
  mentionAgentId?: string | null,
  mentionLabel?: string | null,
): string {
  const lines: string[] = [];
  const mention =
    mentionAgentId && mentionLabel
      ? `[@${mentionLabel}](mention://agent/${mentionAgentId})`
      : null;

  lines.push(
    `## Code review — ${drafts.length} comment${drafts.length === 1 ? "" : "s"}`,
    "",
    mention ? `${mention}, review notes on your changes:` : "Review notes on the diff:",
    "",
  );

  // Group by source (repo/branch), then by file, in line order.
  const bySource = new Map<string, Map<string, DiffReviewDraft[]>>();
  for (const d of drafts) {
    const source = `${d.repo} · ${d.branch}`;
    if (!bySource.has(source)) bySource.set(source, new Map());
    const byFile = bySource.get(source)!;
    if (!byFile.has(d.path)) byFile.set(d.path, []);
    byFile.get(d.path)!.push(d);
  }

  for (const [source, byFile] of bySource) {
    lines.push(`### ${source}`, "");
    for (const [path, list] of byFile) {
      lines.push(`**\`${path}\`**`, "");
      for (const d of [...list].sort((a, b) => a.lineStart - b.lineStart)) {
        const where = d.side === "old" ? "old" : "line";
        const label =
          d.lineStart === d.lineEnd
            ? `${where} ${d.lineStart}`
            : `${where}s ${d.lineStart}–${d.lineEnd}`;
        lines.push(`- **${label}**`);
        if (d.snippet.trim()) {
          lines.push("", "  ```", ...d.snippet.split("\n").map((l) => `  ${l}`), "  ```");
        }
        lines.push("", ...d.body.split("\n").map((l) => `  ${l}`), "");
      }
    }
  }

  lines.push("", "_Posted from the Multica diff viewer._");
  return lines.join("\n");
}
