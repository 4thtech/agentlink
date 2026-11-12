import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELPER_BUNDLE_PATH,
  HELPER_PATH,
  HELPER_SIGN_OPTIONS,
  macSignPlan,
  signingMode,
} from '../lib/sign-plan.mjs';

const app = '/out/AgentLink.app';
const files = [
  `${app}/Contents/Resources/node/bin/node`,
  `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
  `${app}/Contents/Frameworks/AgentLink Helper.app/Contents/MacOS/AgentLink Helper`,
  `${app}/Contents/MacOS/AgentLink`,
];
const bundles = [
  `${app}/Contents/Frameworks/Electron Framework.framework`,
  `${app}/Contents/Frameworks/AgentLink Helper.app`,
];

test('ad-hoc plan signs Electron parts and the outer bundle inside-out, and never the bundled node', () => {
  const plan = macSignPlan({ app, files, bundles });
  const targets = plan.map((s) => s.target);
  assert.ok(!targets.some((t) => t.includes('/Resources/node/')));
  assert.equal(targets.at(-1), app);
  assert.ok(
    targets.indexOf(`${app}/Contents/Frameworks/AgentLink Helper.app`) < targets.indexOf(app),
  );
  assert.ok(
    targets.indexOf(
      `${app}/Contents/Frameworks/AgentLink Helper.app/Contents/MacOS/AgentLink Helper`,
    ) < targets.indexOf(`${app}/Contents/Frameworks/AgentLink Helper.app`),
  );
  for (const s of plan) assert.equal(s.identity, '-');
});

test('signing mode is off unless explicitly switched on', () => {
  assert.equal(signingMode({}), 'adhoc');
  assert.equal(signingMode({ DESKTOP_SIGNING: 'on' }), 'developer-id');
  assert.equal(signingMode({ DESKTOP_SIGNING: 'yes' }), 'adhoc');
});

test('developer-id mode needs an identity and is refused without one', () => {
  assert.throws(() => macSignPlan({ app, files, bundles, mode: 'developer-id' }), /identity/);
});

test('a bundled node outside the expected path is still refused', () => {
  assert.throws(
    () => macSignPlan({ app, files, bundles: [...bundles, `${app}/Contents/Resources/node`] }),
    /node/,
  );
});

// DESK051-C3: the presence helper is an app bundle in Contents/Helpers. Both its executable and the
// bundle keep the fixed identifier and the hardened runtime; other nested apps do not get them.
test('the presence helper app and its executable are signed with the helper identity', () => {
  const helperApp = `${app}${HELPER_BUNDLE_PATH}`;
  const helperExe = `${app}${HELPER_PATH}`;
  const plan = macSignPlan({
    app,
    files: [...files, helperExe],
    bundles: [...bundles, helperApp],
  });
  for (const target of [helperApp, helperExe]) {
    const step = plan.find((s) => s.target === target);
    assert.deepEqual(step.options, [...HELPER_SIGN_OPTIONS], target);
  }
  const targets = plan.map((s) => s.target);
  assert.ok(targets.indexOf(helperExe) < targets.indexOf(helperApp));
  assert.ok(targets.indexOf(helperApp) < targets.indexOf(app));
  const electronHelper = plan.find((s) => s.target.endsWith('/AgentLink Helper.app'));
  assert.deepEqual(electronHelper.options, []);
});
