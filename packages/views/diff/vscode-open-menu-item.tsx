"use client";

import { Code } from "lucide-react";
import { toast } from "sonner";
import { useCurrentWorkspace } from "@multica/core/paths";
import type { Issue } from "@multica/core/types";
import type { MenuPrimitives } from "../issues/actions/issue-actions-menu-items";
import { useDiffClient, useDiffOpenVscodeRemote } from "./diff-context";
import { loadDiffFamily } from "./use-diff-family";
import { useT } from "../i18n";

/**
 * "Open in VS Code" for the issue actions menu — independent of whether the diff
 * modal is open. Opens the task's worktree root (every repo of that run). On a
 * remote client it opens over the tunnel on THIS machine; on the host the
 * daemon opens it locally.
 *
 * The worktree is resolved the same way the diff is (the daemon inspects what is
 * on disk), NOT by the newest run's API `work_dir` — a task can have several run
 * dirs and the newest is often an audit run with an empty checkout, which would
 * open the wrong folder.
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
  const workspace = useCurrentWorkspace();

  const onClick = async () => {
    try {
      const fam = await loadDiffFamily(issue.id);
      let target: string | undefined;

      const wsId = workspace?.id;
      if (wsId) {
        try {
          const res = await client.sources({
            workspace_id: wsId,
            runs: fam.runs,
            codes: fam.codes,
          });
          const primary =
            res.sources.find((source) => source.primary) ?? res.sources[0];
          if (primary?.workdir) {
            // primary.workdir is the repo checkout (…/workdir/<repo>); open the
            // run's workdir root so every repo of that run is visible.
            const match = primary.workdir.match(/^(.*\/workdir)(?:\/[^/]+)?$/);
            target = match ? match[1] : primary.workdir;
          }
        } catch {
          // fall through to the newest run's workdir
        }
      }

      if (!target) {
        const run = fam.runs
          .filter((r) => r.work_dir)
          .sort((a, b) =>
            (b.created_at ?? "").localeCompare(a.created_at ?? ""),
          )[0];
        target = run?.work_dir || undefined;
      }

      if (!target) {
        toast.error(t(($) => $.no_worktree));
        return;
      }

      if (openVscodeRemote) {
        const err = await openVscodeRemote(target);
        if (err) throw new Error(err);
      } else {
        await client.open({ workdir: target, repo_path: "", tool: "vscode" });
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
