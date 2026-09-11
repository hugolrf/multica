"use client";

import { Code } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import type { MenuPrimitives } from "../issues/actions/issue-actions-menu-items";
import { useDiffClient, useDiffOpenVscodeRemote } from "./diff-context";
import { useT } from "../i18n";

/**
 * "Open in VS Code" for the issue actions menu — independent of whether a diff
 * exists. Opens the task's most recent worktree (the run's workdir root, with
 * every repo inside). On a remote client it opens over the tunnel on THIS
 * machine; on the host the daemon opens it locally.
 */
export function VscodeOpenMenuItem({
  issue,
  primitives: P,
}: {
  issue: Issue;
  primitives: MenuPrimitives;
}) {
  const { t } = useT("diff");
  const client = useDiffClient();
  const openVscodeRemote = useDiffOpenVscodeRemote();

  const onClick = async () => {
    try {
      const tasks = await api.listTasksByIssue(issue.id);
      const run = tasks
        .filter((r) => r.work_dir)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
      const workdir = run?.work_dir;
      if (!workdir) {
        toast.error(t(($) => $.no_worktree));
        return;
      }
      if (openVscodeRemote) {
        const err = await openVscodeRemote(workdir);
        if (err) throw new Error(err);
      } else {
        await client.open({ workdir, repo_path: "", tool: "vscode" });
      }
      toast.success(t(($) => $.opened_vscode));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <P.Item onClick={onClick}>
      <Code className="h-3.5 w-3.5" />
      {t(($) => $.open_vscode)}
    </P.Item>
  );
}
