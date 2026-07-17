"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Shared command signature for every operational workspace. */
export type PmsAction = (
  action: string,
  payload?: Record<string, string>,
) => Promise<boolean>;

type PmsActionState = {
  busy: string;
  act: PmsAction;
};

const PmsActionContext = createContext<PmsActionState | null>(null);

/** Keeps command execution state out of deeply nested workspace props. */
export function PmsActionProvider({
  value,
  children,
}: {
  value: PmsActionState;
  children: ReactNode;
}) {
  return <PmsActionContext.Provider value={value}>{children}</PmsActionContext.Provider>;
}

/** Returns the current PMS command gateway and its in-flight action. */
export function usePmsActions(): PmsActionState {
  const context = useContext(PmsActionContext);
  if (!context) {
    throw new Error("usePmsActions must be used inside PmsActionProvider");
  }
  return context;
}
