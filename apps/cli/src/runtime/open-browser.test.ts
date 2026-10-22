// The browser opener (M1-26-e): which program opens a link, and that only https links are handed over.
import { describe, expect, it } from 'vitest';
import { openerFor } from './open-browser.js';

const URL_OK = 'https://pay.example.test/#v=1&a=0x1111111111111111111111111111111111111111';

describe('openerFor', () => {
  it('passes the link as a single argument, never through a shell', () => {
    expect(openerFor('darwin', URL_OK)).toEqual({ command: 'open', args: [URL_OK] });
    expect(openerFor('linux', URL_OK)).toEqual({ command: 'xdg-open', args: [URL_OK] });
    expect(openerFor('win32', URL_OK)).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', URL_OK],
    });
  });

  it('opens only https links, and only on a known platform', () => {
    expect(openerFor('darwin', 'http://pay.example.test/')).toBeUndefined();
    expect(openerFor('darwin', 'file:///etc/passwd')).toBeUndefined();
    expect(openerFor('darwin', '-a Calculator')).toBeUndefined();
    expect(openerFor('aix', URL_OK)).toBeUndefined();
  });
});
