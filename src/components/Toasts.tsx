/**
 * Toast popups: small confirmations ("Moved …", "Removed …") that slide in at
 * the top of the window. Rendered at the shell level so they overlay every
 * screen.
 *
 * A popup that confirms a reversible change doubles as the Revert button:
 * clicking the bubble undoes exactly that operation (see revertAction). Plain
 * confirmations just dismiss on click.
 */

import type { ReactElement } from "react";
import { dismissToast, useToasts } from "../services/toasts";
import type { Toast } from "../services/toasts";
import { revertAction } from "../services/organize";

/** Inline SVG glyph per toast kind — crisp at small sizes, no icon font. */
const ICONS: Record<Toast["kind"], ReactElement> = {
  success: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10.5l3.4 3.4 7.6-8" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 6l8 8M14 6l-8 8" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 9v5" />
      <circle cx="10" cy="5.75" r="1.1" />
    </svg>
  ),
  loading: (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="toast-spinner">
      <circle cx="10" cy="10" r="6.5" opacity="0.3" />
      <path d="M16.5 10A6.5 6.5 0 0 0 10 3.5" />
    </svg>
  ),
};

export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const undoId = toast.undoId;
        const revertible = undoId !== undefined;
        return (
          <button
            key={toast.id}
            type="button"
            className={`toast ${toast.kind}${revertible ? " is-revertible" : ""}`}
            onClick={() => {
              dismissToast(toast.id);
              if (undoId !== undefined) void revertAction(undoId);
            }}
            title={revertible ? "Click to revert this change" : "Dismiss"}
          >
            <span className="toast-icon" aria-hidden="true">{ICONS[toast.kind] ?? ""}</span>
            <span className="toast-message">{toast.message}</span>
            {revertible && <span className="toast-revert" aria-hidden="true">↩</span>}
          </button>
        );
      })}
    </div>
  );
}
