"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DiffClient } from "@multica/core/diff";

/**
 * Supplies the diff client to the modal.
 *
 * The daemon computes the diff because it runs on the machine holding the
 * clones. Desktop points this at the local daemon; a remote client (the web app
 * on another machine) points it at the same daemon through a tunnel. Injecting
 * the base URL keeps this package free of platform APIs.
 *
 * `ready` reports whether the base URL is usable yet. On desktop the daemon
 * port is only known once the daemon reports "running", so the modal must hold
 * its queries until then instead of firing them at a placeholder URL.
 */
type DiffClientContextValue = { client: DiffClient; ready: boolean };

const DiffClientContext = createContext<DiffClientContextValue | null>(null);

export function DiffClientProvider({
  baseUrl,
  ready = true,
  children,
}: {
  baseUrl: string;
  ready?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ client: new DiffClient(baseUrl), ready }),
    [baseUrl, ready],
  );
  return <DiffClientContext.Provider value={value}>{children}</DiffClientContext.Provider>;
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
