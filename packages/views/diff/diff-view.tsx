"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "@multica/ui/lib/utils";
import type { DiffFile, DiffFilesResponse, DiffLine } from "@multica/core/diff";

export type DiffMode = "inline" | "split";

/** A line the user picked for a review note. */
export interface LineRef {
  path: string;
  side: "new" | "old";
  line: number;
  content: string;
}

/** Active line selection inside one file (anchor + focus, shift-click range). */
export interface LineSelection {
  path: string;
  side: "new" | "old";
  start: number;
  end: number;
}

export interface DiffSelectionApi {
  selection: LineSelection | null;
  /** Click a gutter: plain = start new selection, shift = extend the range. */
  onPickLine: (ref: LineRef, extend: boolean) => void;
  /** Open the composer for the current selection. */
  onComment: () => void;
  /** Number of saved notes per file path, to badge the file header. */
  noteCounts?: Record<string, number>;
}

const ADD = "bg-emerald-500/10";
const DEL = "bg-rose-500/10";
const GUTTER = "select-none text-right text-faint-foreground tabular-nums";

function fileStatusMark(status: DiffFile["status"]): string {
  return status === "added" ? "+" : status === "deleted" ? "−" : status === "renamed" ? "»" : "·";
}

/** Directory dimmed, filename emphasized. */
function PathLabel({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  if (i === -1) return <span className="font-medium">{path}</span>;
  return (
    <span className="truncate">
      <span className="text-muted-foreground">{path.slice(0, i + 1)}</span>
      <span className="font-medium">{path.slice(i + 1)}</span>
    </span>
  );
}

function InlineLine({
  line,
  path,
  api,
}: {
  line: DiffLine;
  path: string;
  api?: DiffSelectionApi;
}) {
  const { t } = useT("diff");
  const sign = line.t === "add" ? "+" : line.t === "del" ? "−" : " ";
  const side: "new" | "old" = line.t === "del" ? "old" : "new";
  const num = line.t === "add" ? line.n : line.t === "del" ? line.o : line.n || "";
  const sel = api?.selection;
  const selected =
    !!sel &&
    !!num &&
    sel.path === path &&
    sel.side === side &&
    num >= sel.start &&
    num <= sel.end;
  const isEnd = selected && num === sel!.end;

  return (
    <div
      className={cn(
        "group/line relative flex",
        line.t === "add" && ADD,
        line.t === "del" && DEL,
        selected && "bg-primary/15",
      )}
    >
      <button
        type="button"
        disabled={!api || !num}
        onClick={(e) => num && api?.onPickLine({ path, side, line: num, content: line.c }, e.shiftKey)}
        className={cn(
          GUTTER,
          "w-12 shrink-0 px-1",
          api && num && "cursor-pointer hover:bg-primary/20 hover:text-foreground",
        )}
        title={api && num ? t(($) => $.comment_hint) : undefined}
      >
        {num || ""}
      </button>
      <span className="w-4 shrink-0 select-none text-center text-faint-foreground">{sign}</span>
      <span className="whitespace-pre-wrap break-all">{line.c}</span>
      {isEnd && api && (
        <button
          type="button"
          onClick={api.onComment}
          className="absolute right-1 top-0 inline-flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-caption text-primary-foreground shadow"
        >
          <MessageSquarePlus className="size-3" />
          {t(($) => $.comment)}
        </button>
      )}
    </div>
  );
}

/** Align del↔add by position inside each block; leftovers become empty cells. */
interface SplitRow {
  l: { t: "del" | "ctx"; num?: number; c: string } | null;
  r: { t: "add" | "ctx"; num?: number; c: string } | null;
}
function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: SplitRow["l"][] = [];
  let adds: SplitRow["r"][] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ l: dels[i] || null, r: adds[i] || null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.t === "del") dels.push({ t: "del", num: l.o, c: l.c });
    else if (l.t === "add") adds.push({ t: "add", num: l.n, c: l.c });
    else {
      flush();
      rows.push({ l: { t: "ctx", num: l.o, c: l.c }, r: { t: "ctx", num: l.n, c: l.c } });
    }
  }
  flush();
  return rows;
}

function SplitCell({
  cell,
  path,
  api,
}: {
  cell: SplitRow["l"] | SplitRow["r"];
  path: string;
  api?: DiffSelectionApi;
}) {
  const { t } = useT("diff");
  if (!cell) return <div className="flex min-w-0 flex-1 bg-surface-hover/30" />;
  const bg = cell.t === "add" ? ADD : cell.t === "del" ? DEL : "";
  const side: "new" | "old" = cell.t === "del" ? "old" : "new";
  const sel = api?.selection;
  const selected =
    !!sel &&
    !!cell.num &&
    sel.path === path &&
    sel.side === side &&
    cell.num >= sel.start &&
    cell.num <= sel.end;
  const isEnd = selected && cell.num === sel!.end;
  return (
    <div className={cn("relative flex min-w-0 flex-1", bg, selected && "bg-primary/15")}>
      <button
        type="button"
        disabled={!api || !cell.num}
        onClick={(e) =>
          cell.num && api?.onPickLine({ path, side, line: cell.num, content: cell.c }, e.shiftKey)
        }
        className={cn(
          GUTTER,
          "w-12 shrink-0 px-1",
          api && cell.num && "cursor-pointer hover:bg-primary/20 hover:text-foreground",
        )}
        title={api && cell.num ? t(($) => $.comment_hint) : undefined}
      >
        {cell.num || ""}
      </button>
      <span className="min-w-0 whitespace-pre-wrap break-all">{cell.c}</span>
      {isEnd && api && (
        <button
          type="button"
          onClick={api.onComment}
          className="absolute right-1 top-0 z-10 inline-flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-caption text-primary-foreground shadow"
        >
          <MessageSquarePlus className="size-3" />
          {t(($) => $.comment)}
        </button>
      )}
    </div>
  );
}

function FileView({
  file,
  mode,
  api,
}: {
  file: DiffFile;
  mode: DiffMode;
  api?: DiffSelectionApi;
}) {
  const { t } = useT("diff");
  const notes = api?.noteCounts?.[file.path] ?? 0;
  // Files start expanded and can be collapsed one by one as the reviewer
  // works through them (a long diff otherwise stays fully open).
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-md ring-1 ring-surface-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-surface-border bg-surface-hover/60 px-3 py-1.5 text-left text-caption hover:bg-surface-hover"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-faint-foreground">{fileStatusMark(file.status)}</span>
        <PathLabel path={file.path} />
        {notes > 0 && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-caption text-foreground">
            {t(($) => $.notes, { count: notes })}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.add}</span>{" "}
          <span className="text-rose-600 dark:text-rose-400">−{file.del}</span>
        </span>
      </button>
      {!open ? null : file.binary ? (
        <div className="px-3 py-2 text-caption text-muted-foreground">{t(($) => $.binary_file)}</div>
      ) : (
        <div className="overflow-x-auto font-mono text-caption leading-relaxed">
          {file.hunks.map((h, hi) => (
            <div key={hi}>
              <div className="bg-sky-500/10 px-2 py-0.5 text-sky-700 dark:text-sky-300">{h.header}</div>
              {mode === "split"
                ? toSplitRows(h.lines).map((row, ri) => (
                    <div key={ri} className="flex divide-x divide-surface-border">
                      <SplitCell cell={row.l} path={file.path} api={api} />
                      <SplitCell cell={row.r} path={file.path} api={api} />
                    </div>
                  ))
                : h.lines.map((l, li) => (
                    <InlineLine key={li} line={l} path={file.path} api={api} />
                  ))}
            </div>
          ))}
          {file.truncated && (
            <div className="px-3 py-1 text-caption text-muted-foreground">
              {t(($) => $.diff_truncated)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a full structured diff for one source, inline or side-by-side. */
export function DiffFilesetView({
  fileset,
  mode,
  api,
}: {
  fileset: DiffFilesResponse;
  mode: DiffMode;
  api?: DiffSelectionApi;
}) {
  const { t } = useT("diff");
  const files = useMemo(() => fileset.files, [fileset]);
  if (!files.length) {
    return <div className="px-1 py-2 text-caption text-muted-foreground">{t(($) => $.no_changes)}</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      {files.map((f, i) => (
        <FileView key={`${f.path}:${i}`} file={f} mode={mode} api={api} />
      ))}
      {fileset.truncated_files > 0 && (
        <div className="text-caption text-muted-foreground">
          {t(($) => $.more_files_omitted, { count: fileset.truncated_files })}
        </div>
      )}
    </div>
  );
}
