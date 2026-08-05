import { create } from "zustand";

/**
 * Client state for the task Diff modal: which issue it is open for.
 * Shared stores live in packages/core (see the state rules), so both the
 * desktop shell and the web app can open the same modal.
 */
interface DiffModalState {
  issueId: string | null;
  open: (issueId: string) => void;
  close: () => void;
}

export const useDiffModalStore = create<DiffModalState>((set) => ({
  issueId: null,
  open: (issueId) => set({ issueId }),
  close: () => set({ issueId: null }),
}));
