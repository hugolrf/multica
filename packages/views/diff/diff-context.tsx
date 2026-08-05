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
 */
const DiffClientContext = createContext<DiffClient | null>(null);

export function DiffClientProvider({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: ReactNode;
}) {
  const client = useMemo(() => new DiffClient(baseUrl), [baseUrl]);
  return <DiffClientContext.Provider value={client}>{children}</DiffClientContext.Provider>;
}

export function useDiffClient(): DiffClient {
  const client = useContext(DiffClientContext);
  if (!client) {
    throw new Error("useDiffClient requires a DiffClientProvider ancestor");
  }
  return client;
}
