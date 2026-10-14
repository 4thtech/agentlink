import { describe, expect, it } from 'vitest';
import { checkManifest } from './check-manifests.mjs';

const ok = { license: 'MIT', private: true, scripts: { build: 'tsc -b' } };

describe('checkManifest', () => {
  it('accepts a private MIT package without install scripts', () => {
    expect(checkManifest(ok)).toEqual([]);
  });

  it('rejects a missing or different license', () => {
    expect(checkManifest({ ...ok, license: undefined })).toHaveLength(1);
    expect(checkManifest({ ...ok, license: 'Apache-2.0' })).toHaveLength(1);
  });

  it.each(['preinstall', 'install', 'postinstall'])('rejects a %s script', (name) => {
    const problems = checkManifest({ ...ok, scripts: { [name]: 'node evil.js' } });
    expect(problems).toEqual([`must not declare a "${name}" script`]);
  });

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
