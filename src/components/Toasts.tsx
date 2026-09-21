/**
 * Toast popups: small confirmations ("Moved …", "Removed …") that slide in at
 * the top of the window and auto-dismiss. Rendered at the shell level so they
 * overlay every screen. Clicking a toast dismisses it early.
 */

import { dismissToast, useToasts } from "../services/toasts";
import type { Toast } from "../services/toasts";

/** Glyph per toast kind (text icons keep the bundle and CSS simple). */
const ICONS: Record<Toast["kind"], string> = {
  loading: "⋯",
  info: "ℹ",
  success: "✓",
  error: "✕",
};

export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast ${toast.kind}`}
          onClick={() => dismissToast(toast.id)}
          title="Dismiss"
        >
          <span className="toast-icon" aria-hidden="true">{ICONS[toast.kind] ?? ""}</span>
          <span className="toast-message">{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
