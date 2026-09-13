/**
 * Message bar above the content: a spinner while loading, colour by kind.
 */

import { useApp } from "../services/store";

export function StatusBar() {
  const status = useApp().status;
  if (!status) return null;
  return (
    <div className={`status-bar ${status.kind}`}>
      {status.kind === "loading" && <span className="spinner" aria-hidden="true" />}
      {status.message}
    </div>
  );
}
