import { useEffect, useState, type ReactNode } from "react";
import { IssueActionsExtraItemsProvider } from "@multica/views/issues/components";
import { DiffClientProvider, DiffMenuItem, DiffModal } from "@multica/views/diff";

/**
 * Desktop wiring for the diff review feature.
 *
 * The diff is computed by the local daemon — it is the process that can see the
 * clones — so this layer only resolves the daemon's base URL and mounts the
 * shared modal plus its "Diff" entry in the issue actions menu.
 *
 * The port is derived from the CLI profile, so the renderer has to ask the main
 * process for it. That answer is only available once the daemon reports
 * "running", which can happen after this component mounts (the app often starts
 * before the daemon is up), hence the retry. Until the real port is known the
 * provider reports `ready={false}` so the modal never posts to a guessed port.
 */
export function DesktopDiffProvider({ children }: { children: ReactNode }) {
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
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
  }, []);

  return (
    <DiffClientProvider
      baseUrl={port ? `http://127.0.0.1:${port}` : "http://127.0.0.1"}
      ready={port != null}
    >
      <IssueActionsExtraItemsProvider render={(ctx) => <DiffMenuItem {...ctx} />}>
        {children}
        <DiffModal />
      </IssueActionsExtraItemsProvider>
    </DiffClientProvider>
  );
}
