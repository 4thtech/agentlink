// App icon. Always the real brand artwork in apps/desktop/assets (AgentLink.icns, AgentLink.ico);
// a missing file fails the build, so no placeholder or Electron icon can ship.
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_DIR } from './stage.mjs';

/** Copies the real brand icon to `dest` (a .icns path). Fails when the artwork is missing: no placeholder. */
export function makeIcns(dest) {
  const given = join(DESKTOP_DIR, 'assets', 'AgentLink.icns');
  if (!existsSync(given))
    throw new Error(`Missing ${given}: refusing to build without the AgentLink icon.`);
  copyFileSync(given, dest);
  return 'assets';
}

/** Path to the real Windows icon. Fails when missing. */
export function winIcoPath() {
  const given = join(DESKTOP_DIR, 'assets', 'AgentLink.ico');
  if (!existsSync(given))
    throw new Error(`Missing ${given}: refusing to build without the AgentLink icon.`);
  return given;
}
