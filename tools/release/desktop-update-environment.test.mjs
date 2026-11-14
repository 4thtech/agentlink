import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvironment, main } from './desktop-update-environment.mjs';

const owner = { type: 'User', reviewer: { login: 'talirezun', type: 'User' } };
const env = (reviewers = [owner], extra = {}) => ({
  name: 'desktop-update',
  can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', reviewers }],
  deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  ...extra,
});
const policies = { branch_policies: [{ name: 'main', type: 'branch' }] };

describe('desktop-update environment guard', () => {
  it('accepts the owner as the only reviewer', () => {
    expect(() => checkEnvironment(env(), policies)).not.toThrow();
  });
  it('fails closed for a different reviewer', () => {
    const other = { type: 'User', reviewer: { login: 'denisjazbec' } };
    expect(() => checkEnvironment(env([other]), policies)).toThrow(/not talirezun/);
  });
  it('fails closed when another reviewer is added next to the owner', () => {
    const other = { type: 'User', reviewer: { login: 'someone' } };
    expect(() => checkEnvironment(env([owner, other]), policies)).toThrow(/not talirezun/);
  });
  it('fails closed for a team or a reviewer with no login', () => {
    expect(() =>
      checkEnvironment(env([{ type: 'Team', reviewer: { slug: 'x' } }]), policies),
    ).toThrow();
    expect(() => checkEnvironment(env([{ type: 'User', reviewer: {} }]), policies)).toThrow();
    expect(() => checkEnvironment(env([{ type: 'User' }]), policies)).toThrow();
  });
  it('still fails for no reviewer, admin bypass, wrong branch policy, missing environment', () => {
    expect(() => checkEnvironment(env([]), policies)).toThrow(/no required reviewer/);
    expect(() => checkEnvironment(env([owner], { can_admins_bypass: true }), policies)).toThrow();
    expect(() => checkEnvironment(env(), { branch_policies: [{ name: 'dev' }] })).toThrow();
    expect(() => checkEnvironment(null, policies)).toThrow(/does not exist/);
  });
  it('main exits 0 when fine and 1 with an error line otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    const e = join(dir, 'e.json');
    const p = join(dir, 'p.json');
    writeFileSync(p, JSON.stringify(policies));
    const lines = [];
    writeFileSync(e, JSON.stringify(env()));
    expect(main(['--environment', e, '--policies', p], { out: (l) => lines.push(l) })).toBe(0);
    writeFileSync(e, JSON.stringify(env([{ type: 'User', reviewer: { login: 'x' } }])));
    expect(main(['--environment', e, '--policies', p], { out: (l) => lines.push(l) })).toBe(1);
    expect(lines.at(-1)).toMatch(/^::error::/);
  });
});
