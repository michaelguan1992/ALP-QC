import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// True when the module at moduleUrl is the file that Node was asked to run. Both sides are resolved through symbolic
// links: import.meta.url is already the real path, but process.argv[1] keeps the path as typed. Without this, running
// a script through the `current` release link would never match, and the script would exit without doing anything.
export function isEntryPoint(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}
