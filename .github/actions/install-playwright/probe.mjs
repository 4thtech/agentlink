// CHORE-CI-PLAYWRIGHT-2: asks Playwright itself whether this machine can launch each browser.
// Playwright checks its own host requirements (system libraries, library paths) at launch, so the
// answer is the one a test run would get. Prints "ok" and exits 0 when every browser starts;
// exits 1 (and says why, briefly) on any failure, so the caller installs the system libraries.
import { createRequire } from 'node:module';

const names = (process.env.BROWSERS ?? '').split(/\s+/).filter(Boolean);
const require = createRequire(`${process.cwd()}/`);
const failed = [];
try {
  const pw = require('playwright');
  for (const name of names) {
    const type = pw[name];
    if (!type || typeof type.launch !== 'function') {
      failed.push(`${name}: unknown browser`);
      continue;
    }
    try {
      const browser = await type.launch({ timeout: 60_000 });
      await browser.close();
    } catch (e) {
      failed.push(`${name}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
  }
} catch (e) {
  failed.push(`probe error: ${String(e?.message ?? e).split('\n')[0]}`);
}
if (failed.length > 0) {
  console.log(failed.join('\n'));
  process.exit(1);
}
console.log('ok');
