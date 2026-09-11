"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DiffClient } from "@multica/core/diff";

/**
 * Supplies the diff client to the modal.
 *
 * The daemon computes the diff because it runs on the machine holding the
 * clones. Desktop points this at the local daemon; a remote client (the web app
 * on another machine, or a Windows desktop reaching a Mac daemon) points it at
 * that daemon through a tunnel. Injecting the base URL keeps this package free
 * of platform APIs.
 *
 * `ready` reports whether the base URL is usable yet (the desktop daemon port
 * is only known once it reports "running").
 *
 * `openVscodeRemote`, when set, opens a source in VS Code on the CLIENT machine
 * over a tunnel — used by a remote client where asking the daemon to open the
 * editor would open it on the daemon host instead. Null on the host itself.
 */
export type OpenVscodeRemote = (workdir: string) => Promise<string | null>;

type DiffClientContextValue = {
  client: DiffClient;
  ready: boolean;
  openVscodeRemote: OpenVscodeRemote | null;
};

const DiffClientContext = createContext<DiffClientContextValue | null>(null);

export function DiffClientProvider({
  baseUrl,
  ready = true,
  openVscodeRemote = null,
  children,
}: {
  baseUrl: string;
  ready?: boolean;
  openVscodeRemote?: OpenVscodeRemote | null;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ client: new DiffClient(baseUrl), ready, openVscodeRemote }),
    [baseUrl, ready, openVscodeRemote],
  );
  return (
    <DiffClientContext.Provider value={value}>
      {children}
    </DiffClientContext.Provider>
  );
}

export function useDiffClient(): DiffClient {
  const ctx = useContext(DiffClientContext);
  if (!ctx) {
    throw new Error("useDiffClient requires a DiffClientProvider ancestor");
  }
  return ctx.client;
}

export function useDiffClientReady(): boolean {
  const ctx = useContext(DiffClientContext);
  return ctx?.ready ?? false;
}

export function useDiffOpenVscodeRemote(): OpenVscodeRemote | null {
  const ctx = useContext(DiffClientContext);
  return ctx?.openVscodeRemote ?? null;
}
