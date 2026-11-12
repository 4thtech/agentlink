// Which things get signed, in which order. Pure: build-mac.mjs/sign.mjs run the plan with codesign.
//
// Rules (WP-D1 spike d/e):
//  - the bundled `node` keeps its upstream Node.js Foundation signature. Re-signing changes its code
//    identity and every existing keychain item (created by npx/installer node) would prompt;
//  - Electron's own zip fails `codesign --verify` as shipped, so our app bundle, its frameworks and
//    helpers are signed after assembly (ad-hoc today, Developer ID when DESKTOP_SIGNING=on);
//  - signing is inside-out: files, then nested bundles, then the outer app.

const NODE_DIR = '/Contents/Resources/node';

// The owner-presence helper (WP-D12b) keeps a fixed identifier and the hardened runtime even when
// ad-hoc signed, so phase 3 can check it by identity.
export const HELPER_ID = 'io.4thtech.agentlink.presence';
// DESK051-C3: an app bundle (Info.plist + AgentLink icon), so the Touch ID sheet names AgentLink.
export const HELPER_BUNDLE_PATH = '/Contents/Helpers/AgentLink.app';
export const HELPER_PATH = `${HELPER_BUNDLE_PATH}/Contents/MacOS/agentlink-presence`;
export const HELPER_SIGN_OPTIONS = Object.freeze([
  '--identifier',
  HELPER_ID,
  '--options',
  'runtime',
]);

/** 'adhoc' unless DESKTOP_SIGNING is exactly 'on'. */
export function signingMode(env) {
  return env.DESKTOP_SIGNING === 'on' ? 'developer-id' : 'adhoc';
}

const depth = (p) => p.split('/').length;

export function isBundledNode(p) {
  return p.includes(`${NODE_DIR}/`) || p.endsWith(NODE_DIR);
}

/**
 * app: absolute path of the .app; files: Mach-O files inside it; bundles: nested .app/.framework dirs.
 * Returns [{target, identity, options}] in signing order, ending with the app itself.
 */
export function macSignPlan({ app, files, bundles, mode = 'adhoc', identity, entitlements }) {
  if (mode === 'developer-id' && !identity)
    throw new Error('Developer ID signing needs an identity.');
  if (bundles.some(isBundledNode))
    throw new Error('The bundled node must not be a signing target.');
  const id = mode === 'adhoc' ? '-' : identity;
  const options = mode === 'adhoc' ? [] : ['--timestamp', '--options', 'runtime'];
  const ordered = [
    ...[...files].filter((f) => !isBundledNode(f)).sort((a, b) => depth(b) - depth(a)),
    ...[...bundles].sort((a, b) => depth(b) - depth(a)),
  ];
  // Exactly this app's presence helper (its executable and its bundle), nothing that merely ends alike.
  const helperTargets = new Set([`${app}${HELPER_PATH}`, `${app}${HELPER_BUNDLE_PATH}`]);
  const plan = ordered.map((target) => ({
    target,
    identity: id,
    options: helperTargets.has(target)
      ? [
          ...options.filter((o, i, a) => o !== '--options' && a[i - 1] !== '--options'),
          ...HELPER_SIGN_OPTIONS,
        ]
      : options,
  }));
  plan.push({
    target: app,
    identity: id,
    options:
      entitlements && mode !== 'adhoc' ? [...options, '--entitlements', entitlements] : options,
  });
  return plan;
}
