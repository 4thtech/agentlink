// REL051-SF5 (R1-UI-15, related finding): the "Connect with someone new" help line must say what
// `contacts.acceptInvites` gates. The rule gates accepting an invite only (04 §3.6 Accept step 2,
// 06 §2.1 and §3); making one never asks, on any surface (06 §7, 08 §1: "04 §3.6 sets no invite
// policy, so a shell-capable agent gains nothing"). So the line never claims the AI asks before it
// makes or sends an invite, and it says that such an invite connects once the other person accepts.
import { describe, expect, it } from 'vitest';
import { RULES_STRINGS as S } from './strings.js';

describe('Connect with someone new: help line matches enforcement', () => {
  it('names accepting an invite as what asks', () => {
    expect(S.invitesHelp).toMatch(/asks before it accepts an invite/);
  });

  it('never claims the AI asks before it sends or makes an invite', () => {
    expect(S.invitesHelp).not.toMatch(/asks before it (?:accepts or )?(?:sends|makes|creates)/);
    expect(S.invitesHelp).not.toMatch(/accepts or sends/);
  });

  it('says an invite you or your AI send connects when the other person accepts it', () => {
    expect(S.invitesHelp).toMatch(/you or your AI send/);
    expect(S.invitesHelp).toMatch(/when the other person accepts it/);
  });

  it('keeps plain words (11 §5.1)', () => {
    expect(S.invitesHelp).not.toMatch(/wallet|gas|seed phrase|transaction|contact/i);
  });
});
