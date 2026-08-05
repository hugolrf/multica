"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import { api } from "@multica/core/api";
import type { Attachment, Issue } from "@multica/core/types";
import type { DiffFilesResponse } from "@multica/core/diff";
import { DiffFilesetView, type DiffMode } from "./diff-view";
import { useT } from "../i18n";
import { useDiffClient } from "./diff-context";

/**
 * Evidence tab: every attachment across the task family — the screenshots and
 * screen recordings agents leave as proof, plus any delivery `.patch`.
 * Everything comes from the authenticated API, so this works on web and
 * desktop alike.
 */

const fmtSize = (b: number): string =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`;

type EvidenceKind = "image" | "video" | "patch" | "other";

function kindOf(a: Attachment): EvidenceKind {
  const type = a.content_type ?? "";
  if (/^video\//i.test(type)) return "video";
  if (/^image\//i.test(type)) return "image";
  if (/\.(patch|diff)$/i.test(a.filename ?? "")) return "patch";
  return "other";
}

/** Attachment bytes as an object URL, revoked on unmount. */
function useAttachmentUrl(id: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let revoked: string | null = null;
    let cancelled = false;
    void api
      .getAttachmentBlob(id)
      .then((blob) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id, enabled]);

  return { url, error };
}

function ImageThumb({ item, onOpen }: { item: Attachment; onOpen: (url: string) => void }) {
  const { url, error } = useAttachmentUrl(item.id, true);
  return (
    <figure className="flex flex-col overflow-hidden rounded-md ring-1 ring-surface-border">
      <button
        className="flex h-32 items-center justify-center bg-surface-hover/50"
        onClick={() => url && onOpen(url)}
        disabled={!url}
      >
        {url ? (
          <img src={url} alt={item.filename} className="h-full w-full object-cover" loading="lazy" />
        ) : error ? (
          <span className="px-2 text-caption text-rose-600 dark:text-rose-400">{error}</span>
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </button>
      <figcaption className="truncate px-2 py-1 text-caption text-muted-foreground" title={item.filename}>
        {item.filename}
      </figcaption>
    </figure>
  );
}

function VideoItem({ item }: { item: Attachment }) {
  const { t } = useT("diff");
  const [play, setPlay] = useState(false);
  const { url, error } = useAttachmentUrl(item.id, play);
  return (
    <div className="flex flex-col overflow-hidden rounded-md ring-1 ring-surface-border">
      <div className="flex h-40 items-center justify-center bg-black/40">
        {play && url ? (
          <video src={url} controls autoPlay className="h-full w-full" />
        ) : error ? (
          <span className="px-2 text-caption text-rose-600 dark:text-rose-400">{error}</span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setPlay(true)} disabled={play}>
            {play ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {t(($) => $.play_video)}
          </Button>
        )}
      </div>
      <div className="truncate px-2 py-1 text-caption text-muted-foreground" title={item.filename}>
        {item.filename} · {fmtSize(item.size_bytes ?? 0)}
      </div>
    </div>
  );
}

function PatchItem({ item, mode }: { item: Attachment; mode: DiffMode }) {
  const { t } = useT("diff");
  const client = useDiffClient();
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<DiffFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && parsed === null && !loading) {
      setLoading(true);
      try {
        const blob = await api.getAttachmentBlob(item.id);
        const { files, totals } = await client.parse(await blob.text());
        setParsed({
          repo_path: "", branch: "", base: "", merge_base: "", ahead: 0,
          tip: null, commits: [], files, truncated_files: 0, totals,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  }, [open, parsed, loading, item.id, client]);

  return (
    <div className="rounded-md ring-1 ring-surface-border">
      <div className="flex items-center gap-2 px-3 py-2 text-caption">
        <FileText className="size-4 text-muted-foreground" />
        <span className="truncate" title={item.filename}>
          {item.filename}
        </span>
        <span className="text-muted-foreground">{fmtSize(item.size_bytes ?? 0)}</span>
        <Button className="ml-auto" size="sm" variant="outline" onClick={toggle}>
          {loading && <Loader2 className="size-3 animate-spin" />}
          {open ? t(($) => $.hide_diff) : t(($) => $.view_diff)}
        </Button>
      </div>
      {open && (
        <div className="border-t border-surface-border p-3">
          {error && (
            <div className="text-caption text-rose-600 dark:text-rose-400">
              {t(($) => $.error_prefix, { message: error })}
            </div>
          )}
          {parsed && <DiffFilesetView fileset={parsed} mode={mode} />}
        </div>
      )}
    </div>
  );
}

function OtherItem({ item }: { item: Attachment }) {
  const { t } = useT("diff");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const blob = await api.getAttachmentBlob(item.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.filename ?? "attachment";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md px-3 py-2 text-caption ring-1 ring-surface-border">
      <FileText className="size-4 text-muted-foreground" />
      <span className="truncate" title={item.filename}>
        {item.filename}
      </span>
      <span className="text-muted-foreground">{fmtSize(item.size_bytes ?? 0)}</span>
      <Button className="ml-auto" size="sm" variant="outline" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
        {t(($) => $.download)}
      </Button>
    </div>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-8" onClick={onClose}>
      <img src={url} alt="" className="max-h-full max-w-full rounded-md object-contain" />
    </div>
  );
}

export function DiffEvidence({ issues, mode }: { issues: Issue[]; mode: DiffMode }) {
  const { t } = useT("diff");
  const [lightbox, setLightbox] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["diff", "attachments", issues.map((i) => i.id).sort().join(",")],
    staleTime: 30_000,
    queryFn: async () => {
      const groups = await Promise.all(
        issues.map(async (issue) => {
          try {
            return { issue, items: await api.listAttachments(issue.id) };
          } catch {
            return { issue, items: [] as Attachment[] };
          }
        }),
      );
      return groups.filter((g) => g.items.length > 0);
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> {t(($) => $.evidence_loading)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-2 text-caption text-rose-600 dark:text-rose-400">
        {t(($) => $.error_prefix, { message: error instanceof Error ? error.message : String(error) })}
      </div>
    );
  }
  if (!data?.length) {
    return (
      <div className="rounded-lg p-4 text-caption text-muted-foreground ring-1 ring-surface-border">
        {t(($) => $.evidence_empty)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {data.map((g) => {
        const images = g.items.filter((i) => kindOf(i) === "image");
        const videos = g.items.filter((i) => kindOf(i) === "video");
        const patches = g.items.filter((i) => kindOf(i) === "patch");
        const others = g.items.filter((i) => kindOf(i) === "other");
        return (
          <section key={g.issue.id} className="flex flex-col gap-2">
            <header className="flex items-center gap-2 text-caption">
              <span className="font-medium">{g.issue.identifier}</span>
              {!g.issue.parent_issue_id && <Badge variant="secondary">{t(($) => $.root_badge)}</Badge>}
              <span className="truncate text-muted-foreground">{g.issue.title}</span>
            </header>
            {(videos.length > 0 || images.length > 0) && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {videos.map((i) => (
                  <VideoItem key={i.id} item={i} />
                ))}
                {images.map((i) => (
                  <ImageThumb key={i.id} item={i} onOpen={setLightbox} />
                ))}
              </div>
            )}
            {patches.map((i) => (
              <PatchItem key={i.id} item={i} mode={mode} />
            ))}
            {others.map((i) => (
              <OtherItem key={i.id} item={i} />
            ))}
          </section>
        );
      })}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
