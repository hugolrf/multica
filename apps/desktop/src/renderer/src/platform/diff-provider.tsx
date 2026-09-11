import { useEffect, useState, type ReactNode } from "react";
import { IssueActionsExtraItemsProvider } from "@multica/views/issues/components";
import { DiffClientProvider, DiffMenuItem, DiffModal } from "@multica/views/diff";

/**
 * Desktop wiring for the diff review feature.
 *
 * The diff is computed by the daemon that holds the clones. Normally that is the
 * LOCAL daemon (127.0.0.1, port derived from the CLI profile). When the agents
 * run on another machine — e.g. this desktop is a Windows client and the clones
 * live on a Mac — point the diff at that machine's daemon instead by setting a
 * remote base URL: env `MULTICA_DIFF_DAEMON_URL` or a `~/.multica/diff-daemon-url`
 * file, typically a local port forwarded to the remote daemon over an SSH tunnel.
 *
 * `ready={false}` holds the modal's queries until a usable URL is known, so it
 * never posts to a guessed port.
 */
export function DesktopDiffProvider({ children }: { children: ReactNode }) {
  // undefined = still resolving the override; null = no override (use local).
  const [remoteUrl, setRemoteUrl] = useState<string | null | undefined>(
    undefined,
  );
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.daemonAPI
      .getDiffBaseUrl()
      .then((url) => {
        if (!cancelled) setRemoteUrl(url && url.trim() ? url.trim() : null);
      })
      .catch(() => {
        if (!cancelled) setRemoteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // A remote daemon is configured (or we are still resolving it): do not poll
    // the local daemon at all.
    if (remoteUrl !== null) return;

    let cancelled = false;
    const apply = (value?: number): void => {
      if (!cancelled && value) setPort(value);
    };
    const poll = async (): Promise<void> => {
      try {
        apply((await window.daemonAPI.getStatus()).healthPort);
      } catch {
        // Daemon not up yet — the interval below tries again.
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (!cancelled) void poll();
    }, 5_000);
    const unsubscribe = window.daemonAPI.onStatusChange((status) =>
      apply(status.healthPort),
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [remoteUrl]);

  const baseUrl = remoteUrl
    ? remoteUrl
    : port
      ? `http://127.0.0.1:${port}`
      : "http://127.0.0.1";
  const ready = remoteUrl ? true : remoteUrl === null && port != null;

  return (
    <DiffClientProvider baseUrl={baseUrl} ready={ready}>
      <IssueActionsExtraItemsProvider render={(ctx) => <DiffMenuItem {...ctx} />}>
        {children}
        <DiffModal />
      </IssueActionsExtraItemsProvider>
    </DiffClientProvider>
  );
}
