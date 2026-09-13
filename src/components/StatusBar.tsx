/**
 * Compact top-bar message: a spinner while loading, colour by kind.
 */

import { useApp } from "../services/store";

export function StatusBar() {
  const status = useApp().status;
  if (!status) return null;
  return (
    <div className={`status-bar ${status.kind}`} role="status" aria-live="polite">
      {status.kind === "loading" && <span className="spinner" aria-hidden="true" />}
      {status.message}
    </div>
  );
}
