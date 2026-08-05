/**
 * Wire types for the local diff endpoints served by the Multica daemon
 * (`/diff/sources`, `/diff/files`).
 *
 * The daemon owns diff computation because only the machine running it can see
 * the clones. Any client renders the result: the desktop modal talks to
 * 127.0.0.1, and a remote client (e.g. the web app on another machine) can
 * reach the same endpoints through a tunnel.
 *
 * Field names are snake_case to match the Go handlers verbatim.
 */

export interface DiffLine {
  t: "add" | "del" | "ctx" | "meta";
  c: string;
  o?: number;
  n?: number;
}

export interface DiffHunk {
  header: string;
  context: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  path: string;
  oldPath: string;
  status: DiffFileStatus;
  add: number;
  del: number;
  binary: boolean;
  language: string;
  hunks: DiffHunk[];
  truncated: boolean;
}

export interface DiffTotals {
  add: number;
  del: number;
  files: number;
}

export interface BranchTip {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  tree: string;
}

export interface DiffCommit {
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface DiffFileSummary {
  path: string;
  add: number;
  del: number;
  binary: boolean;
}

export interface DiffIssueRef {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

export interface DiffDuplicate {
  branch: string;
  kind: "bare" | "workdir";
  issue: string;
}

/** One resolved diff source: a repo+branch with its detected base. */
export interface DiffSource {
  key: string;
  kind: "bare" | "workdir";
  repo: string;
  repo_path: string;
  repo_display: string;
  /** Agent workdir to open in an external tool; empty when the GC removed it. */
  workdir: string;
  branch: string;
  agent_slug: string;
  agent_id: string;
  agent_name: string;
  issue: DiffIssueRef;
  run_status: string;
  run_created_at: string;
  base: string;
  merge_base: string;
  ahead: number;
  base_kind: string;
  branch_base?: string;
  branch_ahead?: number;
  tip: BranchTip | null;
  totals: DiffTotals;
  files: DiffFileSummary[];
  primary: boolean;
  demote_reasons: string[];
  duplicates: DiffDuplicate[];
}

/** One agent run, as the client read it from the authenticated API. */
export interface DiffRunInput {
  run_id: string;
  work_dir: string;
  status: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  agent_id: string;
  agent_name: string;
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  issue_status: string;
}

export interface DiffSourcesRequest {
  workspace_id: string;
  runs: DiffRunInput[];
  /** Ticket codes from the family's issue titles (e.g. "AGENDA-608"). */
  codes: string[];
}

export interface DiffSourcesResponse {
  sources: DiffSource[];
  candidate_count: number;
  has_local_repos: boolean;
}

export interface DiffFilesRequest {
  repo_path: string;
  branch: string;
  merge_base?: string;
  base_label?: string;
}

export interface DiffFilesResponse {
  repo_path: string;
  branch: string;
  base: string;
  merge_base: string;
  ahead: number;
  tip: BranchTip | null;
  commits: DiffCommit[];
  files: DiffFile[];
  truncated_files: number;
  totals: DiffTotals;
}

export interface DiffOpenRequest {
  workdir: string;
  repo_path: string;
  tool: "gitkraken" | "vscode";
}

export interface DiffParseResponse {
  files: DiffFile[];
  totals: DiffTotals;
}
