// WIN-DESK-1c: the throw-away profile the launch checks start the built app with (never a real
// profile). On Windows the app's data folder is resolved from the Roaming known folder under
// USERPROFILE; Chromium does not create that parent, so when it is missing Electron has no user-data
// path and the single-instance lock fails ("another AgentLink is running" on a first start). A real
// Windows account always has both AppData folders, so the checks create them too (as smoke.mjs).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The env for a launch with `home` as HOME/USERPROFILE/TEMP; creates both AppData folders. */
export function throwAwayEnv(home, base = process.env) {
  const env = {
    PATH: base.PATH,
    SystemRoot: base.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMPDIR: home,
    TEMP: home,
    TMP: home,
  };
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  return env;
}
