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
  /** Undo-stack entry this popup reverts when clicked (see organize.ts).
   *  Undoable popups stay on screen until used or superseded so the revert
   *  affordance does not vanish after a few seconds. */
  undoId?: number;
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

/** Options for {@link showToast}. */
export interface ToastOptions {
  /** Make the popup revert this undo-stack entry when clicked. */
  undoId?: number;
}

/**
 * Show a popup. Plain confirmations auto-dismiss after a few seconds; popups
 * carrying an `undoId` stay until clicked or pushed out of the stack.
 */
export function showToast(message: string, kind: StatusKind = "success", options: ToastOptions = {}): void {
  const toast: Toast = { id: nextId++, kind, message, ...options };
  // Cap the stack: drop the oldest toast when a newer one arrives.
  if (toasts.length >= MAX_TOASTS) dismissToast(toasts[0].id);
  toasts = [...toasts, toast];
  notify();
  if (options.undoId === undefined) {
    timers.set(toast.id, setTimeout(() => dismissToast(toast.id), TOAST_MS));
  }
}

/** Drop every undoable popup (leaving the playlist screen forgets the stack). */
export function dismissUndoToasts(): void {
  for (const toast of toasts) {
    if (toast.undoId !== undefined) dismissToast(toast.id);
  }
}
