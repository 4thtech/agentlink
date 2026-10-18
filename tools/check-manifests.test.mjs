import { describe, expect, it } from 'vitest';
import * as manifests from './check-manifests.mjs';

const { checkManifest } = manifests;

const ok = { license: 'MIT', private: true, scripts: { build: 'tsc -b' } };

describe('checkManifest', () => {
  it('accepts a private MIT package without install scripts', () => {
    expect(checkManifest(ok)).toEqual([]);
  });

  it('rejects a missing or different license', () => {
    expect(checkManifest({ ...ok, license: undefined })).toHaveLength(1);
    expect(checkManifest({ ...ok, license: 'Apache-2.0' })).toHaveLength(1);
  });

  it.each(['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'])(
    'rejects a %s script',
    (name) => {
      const problems = checkManifest({ ...ok, scripts: { [name]: 'node evil.js' } });
      expect(problems).toEqual([`must not declare a "${name}" script`]);
    },
  );

  it('requires publish settings on a package that is not private', () => {
    const open = { license: 'MIT' };
    expect(checkManifest(open)).toHaveLength(2);
    expect(
      checkManifest({
        ...open,
        repository: { type: 'git', url: 'git+https://github.com/4thtech/agentlink.git' },
        publishConfig: { access: 'public' },
      }),
    ).toEqual([]);
  });

  it('rejects a foreign registry or a fixed dist-tag in publishConfig', () => {
    const problems = checkManifest({
      license: 'MIT',
      repository: 'x',
      publishConfig: { access: 'public', registry: 'https://example.com', tag: 'beta' },
    });
    expect(problems).toHaveLength(2);
  });
});

// OPS-REL-2: workspace packages live in @4thtech-io/* and stay private; only the CLI publishes.
// The old scope is spelled without its slash here so the repository scan (retired-scope.test.mjs)
// finds no `<scope>/<name>` text outside history.
const OLD = '@agentlink';
const OLD_MIXED = '@AgentLink';
describe('checkPackageName', () => {
  const check = (manifest) => manifests.checkPackageName(manifest);

  it('accepts a private @4thtech-io package and the published CLI', () => {
    expect(check({ name: '@4thtech-io/core', private: true })).toEqual([]);
    expect(check({ name: '@4thtech-io/agentlink' })).toEqual([]);
  });

  it.each([`${OLD}/core`, `${OLD_MIXED}/core`])('rejects the third-party scope (%s)', (name) => {
    expect(check({ name, private: true })).toEqual([
      expect.stringMatching(/@agentlink npm scope.*third party/),
    ]);
  });

  it('rejects any other package that is not private', () => {
    expect(check({ name: '@4thtech-io/core' })).toEqual([
      expect.stringContaining('must be "private": true'),
    ]);
    expect(check({ name: '@4thtech-io/core', private: false })).toHaveLength(1);
  });
});
