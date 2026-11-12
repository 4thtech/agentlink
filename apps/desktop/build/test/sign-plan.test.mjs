import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macSignPlan, signingMode } from '../lib/sign-plan.mjs';

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
  assert.ok(targets.indexOf(`${app}/Contents/Frameworks/AgentLink Helper.app`) < targets.indexOf(app));
  assert.ok(targets.indexOf(`${app}/Contents/Frameworks/AgentLink Helper.app/Contents/MacOS/AgentLink Helper`) < targets.indexOf(`${app}/Contents/Frameworks/AgentLink Helper.app`));
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
  assert.throws(() => macSignPlan({ app, files, bundles: [...bundles, `${app}/Contents/Resources/node`] }), /node/);
});
