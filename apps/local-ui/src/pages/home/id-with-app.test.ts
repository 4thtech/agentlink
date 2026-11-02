// W7-ID-B2: an ID is shown with its AI app next to it on this computer only ("Tali · Claude Code"),
// and an approval says which ID is asking.
import { describe, expect, it } from 'vitest';
import { HOME_STRINGS as S, fmt, idWithApp } from './people-strings.js';

describe('idWithApp', () => {
  it('puts the AI app next to the ID name', () => {
    expect(idWithApp('Tali', 'Claude Code')).toBe('Tali · Claude Code');
  });
  it('leaves the app out when unknown or already the name', () => {
    expect(idWithApp('Tali', undefined)).toBe('Tali');
    expect(idWithApp('Claude Code', 'claude code')).toBe('Claude Code');
    expect(idWithApp('', 'Claude Code')).toBe('');
  });
});

describe('who is asking and the conversation sides', () => {
  it('names the ID that is asking', () => {
    expect(fmt(S.askerApp, { app: 'Claude Code' })).toBe("Claude Code's ID is asking");
    expect(fmt(S.askerId, { name: 'Tali' })).toBe('Tali is asking');
  });
  it('says You (app) and the contact by name', () => {
    expect(fmt(S.yourAi, { name: 'Claude Code' })).toBe('You (Claude Code)');
    expect(fmt(S.theirAi, { name: 'Ana' })).toBe('Ana (their AI)');
  });
});
