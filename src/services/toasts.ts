/**
 * Toasts: small ephemeral popups at the top of the window that confirm
 * organize actions (added / moved / removed / reverted). Kept apart from the
 * header status bar, which deliberately only surfaces errors — see
 * components/StatusBar.tsx.
 *
 * Same immutable-snapshot + subscribe pattern as store.ts, just self-contained
 * (toasts are momentary UI sugar, not app state).
 */

import { useSyncExternalStore } from "react";
import type { StatusKind } from "./types";

/** One popup entry. */
export interface Toast {
  /** Stable key for React rendering. */
  id: number;
  kind: StatusKind;
  message: string;
}

/** Maximum popups stacked at once — older ones yield to newer messages. */
const MAX_TOASTS = 4;

/** Milliseconds a toast stays visible before it dismisses itself. */
const TOAST_MS = 3200;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Current toast snapshot (referentially stable between updates). */
export function getToasts(): Toast[] {
  return toasts;
}

/** Subscribe to toast changes (React `useSyncExternalStore` compatible). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the current toast list. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getToasts);
}

/** Remove a toast (timer expiry or click) and clear its timer. */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  notify();
}

/** Show a popup; it auto-dismisses after a few seconds. */
export function showToast(message: string, kind: StatusKind = "success"): void {
  const toast: Toast = { id: nextId++, kind, message };
  // Cap the stack: drop the oldest toast when a newer one arrives.
  if (toasts.length >= MAX_TOASTS) dismissToast(toasts[0].id);
  toasts = [...toasts, toast];
  notify();
  timers.set(toast.id, setTimeout(() => dismissToast(toast.id), TOAST_MS));
}
