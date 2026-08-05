import { useState } from "react";
import { Loader2, Send, Trash2, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import type { DiffReviewDraft } from "./review-types";
import { useT } from "../i18n";

/** Inline composer shown when the user picked a line range. */
export function ReviewComposer({
  path,
  lineStart,
  lineEnd,
  onCancel,
  onSave,
}: {
  path: string;
  lineStart: number;
  lineEnd: number;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const { t } = useT("diff");
  const [body, setBody] = useState("");
  const label =
    lineStart === lineEnd
      ? t(($) => $.line, { line: lineStart })
      : t(($) => $.lines, { start: lineStart, end: lineEnd });
  return (
    <div className="rounded-md bg-surface-raised p-3 ring-1 ring-primary/40">
      <div className="mb-2 flex items-center gap-2 text-caption text-muted-foreground">
        <span className="truncate font-mono">{path}</span>
        <span>{label}</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onCancel}>
          <X className="size-3.5" />
        </Button>
      </div>
      <Textarea
        autoFocus
        rows={3}
        value={body}
        placeholder={t(($) => $.composer_placeholder)}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) {
            e.preventDefault();
            onSave(body.trim());
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!body.trim()} onClick={() => onSave(body.trim())}>
          {t(($) => $.add_note)}
        </Button>
        <span className="text-caption text-muted-foreground">{t(($) => $.add_shortcut)}</span>
      </div>
    </div>
  );
}

/** Sticky footer: pending notes + submit-the-whole-review action. */
export function ReviewBar({
  drafts,
  authorName,
  canMention,
  mention,
  onToggleMention,
  onRemove,
  onSubmit,
  submitting,
}: {
  drafts: DiffReviewDraft[];
  authorName: string | null;
  canMention: boolean;
  mention: boolean;
  onToggleMention: (v: boolean) => void;
  onRemove: (id: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const { t } = useT("diff");
  const [expanded, setExpanded] = useState(false);
  if (!drafts.length) return null;

  return (
    <div className="shrink-0 border-t border-surface-border bg-surface-raised">
      {expanded && (
        <div className="max-h-48 overflow-y-auto border-b border-surface-border p-3">
          <div className="flex flex-col gap-2">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-start gap-2 text-caption">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {d.path.split("/").pop()}:
                  {d.lineStart === d.lineEnd ? d.lineStart : `${d.lineStart}–${d.lineEnd}`}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{d.body}</span>
                <Button size="icon-sm" variant="ghost" onClick={() => onRemove(d.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 p-3">
        <button
          className={cn("text-caption underline-offset-2 hover:underline")}
          onClick={() => setExpanded((v) => !v)}
        >
          {t(($) => $.pending_notes, { count: drafts.length })}
        </button>
        {canMention && (
          <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <input
              type="checkbox"
              checked={mention}
              onChange={(e) => onToggleMention(e.target.checked)}
            />
            {t(($) => $.mention_author, { name: authorName ?? "" })}
          </label>
        )}
        <Button className="ml-auto" size="sm" onClick={onSubmit} disabled={submitting}>
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          {t(($) => $.submit_review, { count: drafts.length })}
        </Button>
      </div>
    </div>
  );
}
