/** A pending review note anchored to one line or a line range of a file. */
export interface DiffReviewDraft {
  id: string;
  sourceKey: string;
  repo: string;
  branch: string;
  path: string;
  /** Line numbers in the NEW file (or OLD when the range is deleted lines). */
  side: "new" | "old";
  lineStart: number;
  lineEnd: number;
  /** The code the note refers to, quoted back into the comment. */
  snippet: string;
  body: string;
}
