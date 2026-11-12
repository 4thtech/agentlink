// Runs lib/sign-plan.mjs with codesign (macOS only). Ad-hoc by default; Developer ID only when
// DESKTOP_SIGNING=on and CODESIGN_IDENTITY is set (WP-D18 switches it on; notarization is not here).
import { capture, run, walk, isMachO } from './run.mjs';
import { isBundledNode, macSignPlan, signingMode } from './sign-plan.mjs';

export function planFor(app, env = process.env, entitlements) {
  const entries = walk(app);
  const files = entries
    .filter((e) => !e.dir && !e.symlink && isMachO(e.path) && !isBundledNode(e.path))
    .map((e) => e.path);
  const bundles = entries
    .filter(
      (e) =>
        e.dir &&
        !e.symlink &&
        /\.(app|framework)$/.test(e.path) &&
        e.path !== app &&
        !isBundledNode(e.path),
    )
    .map((e) => e.path);
  const mode = signingMode(env);
  return macSignPlan({ app, files, bundles, mode, identity: env.CODESIGN_IDENTITY, entitlements });
}

/**
 * Runs the plan. `skip`: targets already signed earlier (DESK051-C5: the presence helper is signed
 * before app.asar is packed, because the ASAR records its hash; re-signing would change it).
 */
export function signApp(app, env = process.env, entitlements, { skip = new Set(), only } = {}) {
  const plan = planFor(app, env, entitlements).filter(
    (step) => !skip.has(step.target) && (only === undefined || only.has(step.target)),
  );
  for (const step of plan) {
    const r = capture('codesign', [
      '--force',
      '--sign',
      step.identity,
      ...step.options,
      step.target,
    ]);
    if (r.code !== 0) throw new Error(`codesign failed for ${step.target}: ${r.stderr.trim()}`);
  }
  return plan.length;
}

export function verifyApp(app) {
  run('codesign', ['--verify', '--deep', '--strict', app]);
}

/** `codesign -dvv` facts for one binary: {identifier, authority[], teamId, cdhash}. */
export function describeSignature(file) {
  const r = capture('codesign', ['-dvv', file]);
  const text = `${r.stdout}\n${r.stderr}`;
  const pick = (re) => (text.match(re) ?? [])[1] ?? null;
  return {
    identifier: pick(/^Identifier=(.+)$/m),
    teamId: pick(/^TeamIdentifier=(.+)$/m),
    cdhash: pick(/^CDHash=(.+)$/m),
    authority: [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1]),
  };
}
