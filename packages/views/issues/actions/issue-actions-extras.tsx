"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Issue } from "@multica/core/types";
// Type-only import (erased at build): keeps the runtime module graph acyclic
// even though issue-actions-menu-items imports the hook below at runtime.
import type { MenuPrimitives } from "./issue-actions-menu-items";

/**
 * Platform-injected extra items for the issue actions menu.
 *
 * The 3-dot / right-click menu is shared by web and desktop through
 * `IssueActionsMenuItems`. Some actions only exist on one platform — the
 * desktop-only "Diff" modal, which needs local git access over Electron IPC,
 * must never render (or import Electron) on web. Rather than branch inside
 * shared code, the host app provides a render function here; when no provider
 * is mounted (the web case) the menu shows nothing extra.
 *
 * The renderer receives the current issue and the active menu primitives
 * (dropdown vs. context menu) so the injected item matches the surrounding
 * menu exactly.
 */
export interface IssueActionsExtraContext {
  issue: Issue;
  primitives: MenuPrimitives;
}

type IssueActionsExtraRenderer = (ctx: IssueActionsExtraContext) => ReactNode;

const IssueActionsExtraItemsContext =
  createContext<IssueActionsExtraRenderer | null>(null);

export function IssueActionsExtraItemsProvider({
  render,
  children,
}: {
  render: IssueActionsExtraRenderer;
  children: ReactNode;
}) {
  return (
    <IssueActionsExtraItemsContext.Provider value={render}>
      {children}
    </IssueActionsExtraItemsContext.Provider>
  );
}

/** Null when no host app injected extras (web). */
export function useIssueActionsExtraItems(): IssueActionsExtraRenderer | null {
  return useContext(IssueActionsExtraItemsContext);
}
