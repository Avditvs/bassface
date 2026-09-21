/**
 * Compact top-bar message. Only errors are surfaced — loading/analysis
 * progress notes would be noise in the header and are skipped. The element
 * stays mounted (empty when idle) as the flex spacer that pushes the
 * right-hand header controls across.
 */

import { useApp } from "../services/store";

export function StatusBar() {
  const status = useApp().status;
  const error = status?.kind === "error" ? status.message : "";
  return (
    <div className={`status-bar${error ? " error" : ""}`} role={error ? "alert" : "status"}>
      {error}
    </div>
  );
}
