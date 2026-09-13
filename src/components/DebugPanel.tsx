/**
 * Troubleshooting log panel (connect screen): a live view of the persistent
 * debug ring buffer.
 */

import { useSyncExternalStore } from "react";
import { debugLogText, getDebugLog, subscribeDebugLog } from "../services/debug";

export function DebugPanel() {
  useSyncExternalStore(subscribeDebugLog, getDebugLog);
  return <pre id="debug-log">{debugLogText()}</pre>;
}
