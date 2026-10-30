// W4-WIRE: every "Invite someone" / "Add contact" way in (Home, the empty states, the compact window,
// the map) opens U4's Invite screen; the old Add contact sheet is no longer where they lead.
import { describe, expect, it } from 'vitest';
import { ADD_CONTACT_HREF } from '../contacts/add-contact-link.js';
import { goToEntries } from '../../nav.js';
import { INVITE_HREF } from './home-screen.js';

describe('W4-WIRE: the ways to invite', () => {
  it("Home's Invite someone opens the Invite screen", () => {
    expect(INVITE_HREF).toBe('/contacts?invite');
  });

  it('the shared Add contact link opens the Invite screen too', () => {
    expect(ADD_CONTACT_HREF).toBe('/contacts?invite');
  });

  it('Go to (Cmd+K): Invite someone opens the Invite screen; New agent opens the Get started steps', () => {
    const entries = goToEntries(false);
    expect(entries.find((e) => e.label === 'Invite someone')?.path).toBe('/contacts?invite');
    expect(entries.find((e) => e.label === 'New agent')?.path).toBe('/start/app?add=agent');
  });
});
