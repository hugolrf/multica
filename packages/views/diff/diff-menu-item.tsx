"use client";

import { GitCompare } from "lucide-react";
import { useDiffModalStore } from "@multica/core/diff";
import type { Issue } from "@multica/core/types";
import type { MenuPrimitives } from "../issues/actions/issue-actions-menu-items";
import { useT } from "../i18n";

/**
 * "Diff" entry for the issue actions menu (3-dot and right-click). Rendered
 * through the host app's extras provider so it only appears where a diff
 * client is available.
 */
export function DiffMenuItem({
  issue,
  primitives: P,
}: {
  issue: Issue;
  primitives: MenuPrimitives;
}) {
  const { t } = useT("diff");
  const open = useDiffModalStore((s) => s.open);
  return (
    <P.Item onClick={() => open(issue.id)}>
      <GitCompare className="h-3.5 w-3.5" />
      {t(($) => $.title)}
    </P.Item>
  );
}
