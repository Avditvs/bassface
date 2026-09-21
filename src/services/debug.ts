/**
 * Logging helper. Every line is redacted first: logged URLs can embed OAuth
 * tokens (`?oauth_token=…` on stream URLs) or error bodies quoting secrets.
 */

import { redactSecrets } from "./util";

/** Log a timestamped, redacted line to the console. */
export function dbg(message: string): void {
  console.info(`${new Date().toISOString().slice(11, 19)} ${redactSecrets(message)}`);
}
