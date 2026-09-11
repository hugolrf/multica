"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { extractTicketCodes, type DiffRunInput } from "@multica/core/diff";

/**
 * Resolves the task family of an issue and everything the daemon needs to find
 * its diff sources.
 *
 * A task's changes are spread across the family (parent + descendants): each
 * run can produce its own branch, so the consolidated view walks up to the root
 * and back down. Issues and runs come from the authenticated API — the daemon
 * only handles what requires the filesystem.
 */

export interface DiffFamily {
  root: Issue;
  issues: Issue[];
  runs: DiffRunInput[];
  codes: string[];
}

async function loadFamilyIssues(issueId: string): Promise<{ root: Issue; issues: Issue[] }> {
  // Walk up to the root. Depth is small (subtasks are shallow) and each hop is
  // a cached single-issue read.
  let current = await api.getIssue(issueId);
  const seen = new Set<string>([current.id]);
  while (current.parent_issue_id && !seen.has(current.parent_issue_id)) {
    seen.add(current.parent_issue_id);
    try {
      current = await api.getIssue(current.parent_issue_id);
    } catch {
      break; // parent outside our reach — treat this as the root
    }
  }
  const root = current;

  // Then breadth-first down, batching one request per level.
  const issues: Issue[] = [root];
  let frontier = [root.id];
  while (frontier.length) {
    const { issues: children } = await api.listChildrenByParents(frontier);
    const fresh = children.filter((c) => !issues.some((i) => i.id === c.id));
    if (!fresh.length) break;
    issues.push(...fresh);
    frontier = fresh.map((c) => c.id);
  }
  return { root, issues };
}

/** Family + the runs/codes the daemon needs to resolve diff sources. */
export async function loadDiffFamily(issueId: string): Promise<DiffFamily> {
  const { root, issues } = await loadFamilyIssues(issueId);

  const taskLists = await Promise.all(
    issues.map(async (issue) => {
      try {
        return { issue, tasks: await api.listTasksByIssue(issue.id) };
      } catch {
        return { issue, tasks: [] };
      }
    }),
  );

  const runs: DiffRunInput[] = [];
  for (const { issue, tasks } of taskLists) {
    for (const task of tasks) {
      runs.push({
        run_id: task.id,
        work_dir: task.work_dir ?? "",
        status: task.status ?? "",
        created_at: task.created_at ?? "",
        started_at: task.started_at ?? "",
        completed_at: task.completed_at ?? "",
        agent_id: task.agent_id ?? "",
        agent_name: "",
        issue_id: issue.id,
        issue_identifier: issue.identifier ?? "",
        issue_title: issue.title ?? "",
        issue_status: issue.status ?? "",
      });
    }
  }

  return {
    root,
    issues,
    runs,
    codes: extractTicketCodes(issues.map((i) => i.title ?? "")),
  };
}

export function useDiffFamily(issueId: string | null) {
  return useQuery<DiffFamily>({
    queryKey: ["diff", "family", issueId],
    enabled: Boolean(issueId),
    staleTime: 30_000,
    queryFn: () => loadDiffFamily(issueId!),
  });
}
