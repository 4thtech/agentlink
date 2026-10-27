// M1-11b-2c: moved from packages/node owner-passkey.test.ts ("the page asks for the passkey only
// after a click", 11 §6.2.1), which checked the removed server-rendered page's script. The same
// rules, now on the app code that asks for the passkey: RP ID localhost, user verification
// required, the stored credential in allowCredentials and the PRF extension for a decision, the
// presence header, the fixed passkey path; resident key and user verification required, and only
// RP ID localhost accepted, for the registration on the first-run page. approvals.test.ts checks
// the same values on the real calls (rpId, userVerification) and that nothing is asked before the
// click.
import { describe, expect, it } from 'vitest';

const files = import.meta.glob(
  ['./client.ts', '../first-run/passkey.ts', '../first-run/setup-api.ts'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

function source(name: string): string {
  const entry = Object.entries(files).find(([path]) => path.endsWith(name));
  const text = entry?.[1];
  if (typeof text !== 'string' || text === '') throw new Error(`${name} missing`);
  return text;
}

describe('the app asks for the passkey with the localhost rules (11 §6.2.1; M1-8e)', () => {
  it('a decision: RP ID localhost, the PRF extension, user verification and the stored credential', () => {
    const client = source('./client.ts');
    expect(client).toContain("rpId: 'localhost'");
    expect(client).toContain("userVerification: 'required'");
    expect(client).toContain('allowCredentials');
    expect(client).toContain('prf: { eval: { first:');
    expect(client).toContain("'X-AgentLink-Presence': 'passkey'");
    expect(client).toContain("'/api/owner/passkey'");
    // Only a passkey the server keeps for localhost is offered.
    expect(client).toContain("p['rpId'] !== 'localhost'");
  });

  it('a registration: resident key and user verification required, PRF asked, only localhost', () => {
    const passkey = source('/first-run/passkey.ts');
    expect(passkey).toContain("residentKey: 'required'");
    expect(passkey).toContain("userVerification: 'required'");
    expect(passkey).toContain('prf: { eval: { first:');
    expect(source('/first-run/setup-api.ts')).toContain("rpId !== 'localhost'");
  });
});
