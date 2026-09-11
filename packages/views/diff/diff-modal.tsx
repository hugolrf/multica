"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, GitCompare, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useCurrentWorkspace } from "@multica/core/paths";
import { api } from "@multica/core/api";
import type { DiffFilesResponse, DiffSource } from "@multica/core/diff";
import { useDiffModalStore } from "@multica/core/diff";
import {
  DiffFilesetView,
  type DiffMode,
  type DiffSelectionApi,
  type LineRef,
  type LineSelection,
} from "./diff-view";
import { ReviewBar, ReviewComposer } from "./diff-review";
import type { DiffReviewDraft } from "./review-types";
import { useDiffClient, useDiffClientReady } from "./diff-context";
import { useDiffFamily } from "./use-diff-family";
import { composeReviewMarkdown } from "./compose-review";
import { useT } from "../i18n";
import { DiffEvidence } from "./diff-evidence";


function Stat({ add, del, files }: { add: number; del: number; files?: number }) {
  const { t } = useT("diff");
  return (
    <span className="tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{add.toLocaleString("pt-BR")}</span>{" "}
      <span className="text-rose-600 dark:text-rose-400">−{del.toLocaleString("pt-BR")}</span>
      {typeof files === "number" && (
        <span className="text-muted-foreground"> · {t(($) => $.files, { count: files })}</span>
      )}
    </span>
  );
}

function SourceSection({
  source,
  mode,
  open,
  onToggle,
  review,
  composer,
}: {
  source: DiffSource;
  mode: DiffMode;
  open: boolean;
  onToggle: () => void;
  review?: DiffSelectionApi;
  composer?: React.ReactNode;
}) {
  const [fileset, setFileset] = useState<DiffFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT("diff");
  const [busy, setBusy] = useState<null | "gitkraken" | "vscode">(null);
  const client = useDiffClient();

  const load = useCallback(async () => {
    if (fileset || loading) return;
    setLoading(true);
    setError(null);
    try {
      setFileset(
        await client.files({
          repo_path: source.repo_path,
          branch: source.branch,
          merge_base: source.merge_base,
          base_label: source.base,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fileset, loading, source, client]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const openIn = async (tool: "gitkraken" | "vscode") => {
    setBusy(tool);
    try {
      await client.open({ workdir: source.workdir, repo_path: source.repo_path, tool });
      toast.success(tool === "gitkraken" ? t(($) => $.opened_gitkraken) : t(($) => $.opened_vscode));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={cn("rounded-lg ring-1 ring-surface-border", !source.primary && "opacity-80")}>
      <header className="flex cursor-pointer items-center gap-2 px-3 py-2" onClick={onToggle}>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-caption text-muted-foreground">
          {source.repo}
        </span>
        <span className="truncate font-mono text-caption">{source.branch}</span>
        <span className="text-muted-foreground">→</span>
        <span className="shrink-0 font-mono text-caption text-muted-foreground">{source.base}</span>
        {!source.primary && (
          <Badge variant="secondary" title={source.demote_reasons.join(" · ")}>
            {t(($) => $.secondary)}
          </Badge>
        )}
        {source.duplicates.length > 0 && (
          <Badge variant="outline" title={source.duplicates.map((d) => d.branch).join("\n")}>
            {t(($) => $.identical_branches, { count: source.duplicates.length })}
          </Badge>
        )}
        <span className="ml-auto shrink-0">
          <Stat add={source.totals.add} del={source.totals.del} files={source.totals.files} />
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 pl-9 text-caption text-muted-foreground">
        <span>
          {source.issue.identifier} · {source.issue.status}
        </span>
        <span>
          {source.kind === "bare" ? t(($) => $.agent_branch) : t(($) => $.workdir_checkout)}
          {source.agent_slug ? ` · ${source.agent_slug}` : ""}
        </span>
        <span>
          {t(($) => $.commits_ahead, { count: source.ahead })}
          {source.base_kind === "run" ? t(($) => $.run_window) : ""}
        </span>
        {source.tip && (
          <span className="truncate font-mono">
            {source.tip.short} · {source.tip.subject}
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={(e) => {
              e.stopPropagation();
              void openIn("gitkraken");
            }}
          >
            {busy === "gitkraken" && <Loader2 className="size-3 animate-spin" />}
            {t(($) => $.open_gitkraken)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={(e) => {
              e.stopPropagation();
              void openIn("vscode");
            }}
          >
            {busy === "vscode" && <Loader2 className="size-3 animate-spin" />}
            {t(($) => $.open_vscode)}
          </Button>
        </span>
      </div>

      {open && (
        <div className="border-t border-surface-border p-3">
          {loading && (
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t(($) => $.loading_diff)}
            </div>
          )}
          {error && (
            <div className="text-caption text-rose-600 dark:text-rose-400">
              {t(($) => $.error_prefix, { message: error })}
            </div>
          )}
          {composer}
          {fileset && !loading && (
            <DiffFilesetView fileset={fileset} mode={mode} api={review} />
          )}
        </div>
      )}
    </section>
  );
}

function DiffModalBody({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const workspace = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const { t } = useT("diff");
  const client = useDiffClient();
  const ready = useDiffClientReady();
  const family = useDiffFamily(issueId);
  const [mode, setMode] = useState<DiffMode>("inline");
  const [tab, setTab] = useState<"diff" | "evidence">("diff");
  // Reviewing a diff wants width. Default to a large window, with a
  // maximize toggle and a drag-resizable corner (CSS `resize`) on top.
  const [maximized, setMaximized] = useState(false);
  // null = "Todas" (consolidated family view). Otherwise a single subtask id.
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  // Which source sections are expanded. Controlled here so we can auto-expand
  // the first source both on open and whenever the family filter changes.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  // Line review: current selection (per source), open composer, pending notes.
  const [selection, setSelection] = useState<(LineSelection & { sourceKey: string }) | null>(null);
  const [composing, setComposing] = useState(false);
  const [drafts, setDrafts] = useState<DiffReviewDraft[]>([]);
  const [mentionAuthor, setMentionAuthor] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [snippetLines, setSnippetLines] = useState<Map<number, string>>(new Map());

  // Reset per-issue view state whenever the modal opens on another issue.
  useEffect(() => {
    setSelectedIssueId(null);
    setTab("diff");
    setDrafts([]);
    setSelection(null);
    setComposing(false);
  }, [issueId]);

  // The daemon resolves the diff sources: it runs on the machine holding the
  // clones, so it is the only component that can see them.
  const sourcesQuery = useQuery({
    queryKey: ["diff", "sources", workspaceId, family.data?.root.id],
    enabled: Boolean(workspaceId && family.data && ready),
    staleTime: 15_000,
    queryFn: () =>
      client.sources({
        workspace_id: workspaceId!,
        runs: family.data!.runs,
        codes: family.data!.codes,
      }),
  });

  const loading = !ready || family.isLoading || sourcesQuery.isLoading;
  const queryError = family.error ?? sourcesQuery.error;
  const error = !workspaceId
    ? t(($) => $.no_workspace)
    : queryError
      ? queryError instanceof Error
        ? queryError.message
        : String(queryError)
      : null;
  const detail = sourcesQuery.data ?? null;

  const allSources = useMemo(() => detail?.sources ?? [], [detail]);
  const familyIssues = useMemo(() => family.data?.issues ?? [], [family.data]);
  const rootIdentifier = family.data?.root.identifier ?? "";
  const rootTitle = family.data?.root.title ?? "";

  // Subtasks that actually produced a diff — used to dim empty family chips.
  const issuesWithSources = useMemo(
    () => new Set(allSources.map((s) => s.issue.id)),
    [allSources],
  );

  const visibleSources = useMemo(
    () =>
      selectedIssueId
        ? allSources.filter((s) => s.issue.id === selectedIssueId)
        : allSources,
    [allSources, selectedIssueId],
  );

  // Header totals track the current filter (consolidated vs. single subtask):
  // sum the PRIMARY sources only, dedupe files across branches.
  const totals = useMemo(() => {
    const primary = visibleSources.filter((s) => s.primary);
    const touched = new Set<string>();
    let add = 0;
    let del = 0;
    for (const s of primary) {
      add += s.totals.add;
      del += s.totals.del;
      for (const f of s.files) touched.add(`${s.repo}:${f.path}`);
    }
    return {
      add,
      del,
      files: touched.size,
      branches: primary.length,
      secondary: visibleSources.length - primary.length,
    };
  }, [visibleSources]);

  const firstVisibleKey =
    visibleSources.find((s) => s.primary)?.key ?? visibleSources[0]?.key;

  // Auto-expand the first visible source on load and whenever the filter
  // changes, so the diff is visible without an extra click.
  useEffect(() => {
    setOpenKeys(firstVisibleKey ? new Set([firstVisibleKey]) : new Set());
  }, [firstVisibleKey]);

  const toggleKey = useCallback((key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);


  const pickLine = useCallback(
    (sourceKey: string, ref: LineRef, extend: boolean) => {
      setComposing(false);
      setSelection((prev) => {
        if (
          extend &&
          prev &&
          prev.sourceKey === sourceKey &&
          prev.path === ref.path &&
          prev.side === ref.side
        ) {
          const start = Math.min(prev.start, ref.line);
          const end = Math.max(prev.end, ref.line);
          setSnippetLines((m) => new Map(m).set(ref.line, ref.content));
          return { ...prev, start, end };
        }
        setSnippetLines(new Map([[ref.line, ref.content]]));
        return { sourceKey, path: ref.path, side: ref.side, start: ref.line, end: ref.line };
      });
    },
    [],
  );

  const addDraft = useCallback(
    (body: string) => {
      if (!selection) return;
      const src = allSources.find((s) => s.key === selection.sourceKey);
      const snippet = [...snippetLines.entries()]
        .filter(([n]) => n >= selection.start && n <= selection.end)
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)
        .join("\n");
      setDrafts((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${prev.length}`,
          sourceKey: selection.sourceKey,
          repo: src?.repo ?? "",
          branch: src?.branch ?? "",
          path: selection.path,
          side: selection.side,
          lineStart: selection.start,
          lineEnd: selection.end,
          snippet,
          body,
        },
      ]);
      setComposing(false);
      setSelection(null);
    },
    [selection, allSources, snippetLines],
  );

  // Note badges per file, scoped to the source that owns them.
  const noteCountsBySource = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const d of drafts) {
      const perFile = map.get(d.sourceKey) ?? {};
      perFile[d.path] = (perFile[d.path] ?? 0) + 1;
      map.set(d.sourceKey, perFile);
    }
    return map;
  }, [drafts]);

  // The agent that authored the reviewed changes — mentioning it enqueues a run.
  const author = useMemo(() => {
    const withAgent = (selection
      ? allSources.filter((s) => s.key === selection.sourceKey)
      : allSources
    ).find((s) => s.agent_id);
    const fallback = allSources.find((s) => s.agent_id);
    return withAgent ?? fallback ?? null;
  }, [allSources, selection]);

  const submitReview = useCallback(async () => {
    if (!drafts.length) return;
    setSubmitting(true);
    try {
      const mentionId = mentionAuthor ? author?.agent_id : null;
      const mentionName = mentionAuthor ? author?.agent_name || author?.agent_slug : null;
      await api.createComment(issueId, composeReviewMarkdown(drafts, mentionId, mentionName));
      toast.success(mentionId ? t(($) => $.review_posted_mentioned) : t(($) => $.review_posted));
      setDrafts([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [drafts, mentionAuthor, author, issueId, t]);

  return (
    <DialogContent
      className={cn(
        "flex flex-col gap-0 overflow-hidden p-0",
        maximized
          ? "h-[96vh] max-h-[96vh] w-[98vw] max-w-[98vw] sm:max-w-[98vw]"
          : // resize-both lets the user drag the bottom-right corner
            "h-[92vh] max-h-[96vh] w-[94vw] min-w-[560px] max-w-[96vw] resize overflow-auto sm:max-w-[96vw]",
      )}
    >
      <DialogHeader className="shrink-0 gap-2 border-b border-surface-border p-4 pr-12">
        <DialogTitle className="flex items-center gap-2">
          <GitCompare className="size-4 text-muted-foreground" />
          {detail ? (
            <span className="truncate">
              {rootIdentifier} · {rootTitle}
            </span>
          ) : (
            <span>{t(($) => $.title)}</span>
          )}
        </DialogTitle>
        {detail && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTab("diff")}
              className={cn(
                "rounded-md px-2.5 py-1 text-caption",
                tab === "diff" ? "bg-surface-hover font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(($) => $.tab_diff)}
            </button>
            <button
              onClick={() => setTab("evidence")}
              className={cn(
                "rounded-md px-2.5 py-1 text-caption",
                tab === "evidence" ? "bg-surface-hover font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(($) => $.tab_evidence)}
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              title={maximized ? t(($) => $.restore) : t(($) => $.maximize)}
              onClick={() => setMaximized((v) => !v)}
            >
              {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
          </div>
        )}
        {detail && tab === "diff" && (
          <>
            {familyIssues.length > 1 && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.family_hint, {
                  identifier: rootIdentifier,
                  count: familyIssues.length,
                })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <Stat add={totals.add} del={totals.del} files={totals.files} />
              <Badge variant="secondary">
                {t(($) => $.branches, { count: totals.branches })}
              </Badge>
              {totals.secondary > 0 && (
                <Badge variant="outline">{t(($) => $.secondary_count, { count: totals.secondary })}</Badge>
              )}
              <span className="ml-auto inline-flex overflow-hidden rounded-md ring-1 ring-surface-border">
                <button
                  className={cn(
                    "px-2 py-1 text-caption",
                    mode === "inline" ? "bg-surface-hover font-medium" : "text-muted-foreground",
                  )}
                  onClick={() => setMode("inline")}
                >
                  {t(($) => $.inline)}
                </button>
                <button
                  className={cn(
                    "px-2 py-1 text-caption",
                    mode === "split" ? "bg-surface-hover font-medium" : "text-muted-foreground",
                  )}
                  onClick={() => setMode("split")}
                >
                  {t(($) => $.side_by_side)}
                </button>
              </span>
            </div>
            {familyIssues.length > 1 && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setSelectedIssueId(null)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-caption transition-colors",
                    selectedIssueId === null
                      ? "bg-primary/15 text-foreground ring-1 ring-primary/40"
                      : "bg-surface-hover text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(($) => $.filter_all)}
                </button>
                {familyIssues.map((f) => {
                  const hasDiff = issuesWithSources.has(f.id);
                  const active = selectedIssueId === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setSelectedIssueId(f.id)}
                      title={`${f.title} — ${f.status}${hasDiff ? "" : " · no local diff"}`}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-caption transition-colors",
                        active
                          ? "bg-primary/15 text-foreground ring-1 ring-primary/40"
                          : hasDiff
                            ? "bg-surface-hover text-muted-foreground hover:text-foreground"
                            : "bg-surface-hover/50 text-faint-foreground",
                        f.id === issueId && !active && "ring-1 ring-surface-border",
                      )}
                    >
                      {f.identifier}
                      {!f.parent_issue_id ? t(($) => $.root_suffix) : ""}
                      {f.id === issueId ? " ·" : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> {t(($) => $.building)}
          </div>
        )}
        {error && !loading && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-body font-medium">{t(($) => $.load_error_title)}</p>
            <p className="text-caption text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t(($) => $.close)}
            </Button>
          </div>
        )}
        {detail && !loading && !error && tab === "evidence" && (
          <DiffEvidence issues={familyIssues} mode={mode} />
        )}
        {detail && !loading && !error && tab === "diff" && (
          <div className="flex flex-col gap-3">
            {visibleSources.length === 0 ? (
              <div className="rounded-lg ring-1 ring-surface-border p-4 text-caption text-muted-foreground">
                {selectedIssueId
                  ? t(($) => $.empty_subtask)
                  : t(($) => $.empty_task, { count: detail.candidate_count })}
              </div>
            ) : (
              visibleSources.map((s) => {
                const sel =
                  selection && selection.sourceKey === s.key
                    ? { path: selection.path, side: selection.side, start: selection.start, end: selection.end }
                    : null;
                return (
                  <SourceSection
                    key={s.key}
                    source={s}
                    mode={mode}
                    open={openKeys.has(s.key)}
                    onToggle={() => toggleKey(s.key)}
                    review={{
                      selection: sel,
                      onPickLine: (ref, extend) => pickLine(s.key, ref, extend),
                      onComment: () => setComposing(true),
                      noteCounts: noteCountsBySource.get(s.key),
                    }}
                    composer={
                      composing && selection && selection.sourceKey === s.key ? (
                        <div className="mb-3">
                          <ReviewComposer
                            path={selection.path}
                            lineStart={selection.start}
                            lineEnd={selection.end}
                            onCancel={() => {
                              setComposing(false);
                              setSelection(null);
                            }}
                            onSave={addDraft}
                          />
                        </div>
                      ) : null
                    }
                  />
                );
              })
            )}
          </div>
        )}
      </div>

      {tab === "diff" && (
        <ReviewBar
          drafts={drafts}
          authorName={author?.agent_name ?? author?.agent_slug ?? null}
          canMention={Boolean(author?.agent_id)}
          mention={mentionAuthor}
          onToggleMention={setMentionAuthor}
          onRemove={(id) => setDrafts((prev) => prev.filter((d) => d.id !== id))}
          onSubmit={submitReview}
          submitting={submitting}
        />
      )}
    </DialogContent>
  );
}

/**
 * Desktop-only task Diff modal. Mounted once in the shell; opens when the
 * "Diff" issue-action item sets the store. Shows the consolidated diff of the
 * issue's task family (parent + descendants), grouped by repo/branch, with an
 * inline / side-by-side toggle, per-subtask filtering, and GitKraken / VS Code
 * shortcuts.
 */
export function DiffModal() {
  const issueId = useDiffModalStore((s) => s.issueId);
  const close = useDiffModalStore((s) => s.close);
  return (
    <Dialog open={!!issueId} onOpenChange={(o) => !o && close()}>
      {issueId && <DiffModalBody issueId={issueId} onClose={close} />}
    </Dialog>
  );
}
