// RELAY-SHARED-CONN L2: the local channel's frame codec. Strict: unknown, malformed or oversized
// frames are refused with a fixed reason that never carries any of the frame's content (I-7).
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES } from './relay-pool.js';
import {
  LinkFrameReader,
  SHARED_LINK_MAX_FRAME_BYTES,
  SHARED_LINK_VERSION,
  checkLinkProof,
  decodeClientFrame,
  decodeServerFrame,
  encodeLinkFrame,
  linkFrameBytes,
  linkProof,
  type ClientFrame,
  type ServerFrame,
} from './shared-link-protocol.js';

const NONCE = 'ab'.repeat(32);
const PROOF = '12'.repeat(32);
const URL_A = 'wss://relay-a.nostr-test.dev';
const ID = 'cd'.repeat(32);

describe('frame codec', () => {
  it('round-trips every client frame', () => {
    const frames: ClientFrame[] = [
      { t: 'hello', v: SHARED_LINK_VERSION, cli: '0.5.18', nonce: NONCE },
      { t: 'prove', proof: PROOF },
      { t: 'open', link: 1, url: URL_A },
      { t: 'open', link: 2, url: URL_A, auth: false },
      { t: 'send', link: 1, data: '["REQ","s1",{"kinds":[1059]}]' },
      { t: 'send', link: 2, data: 'a\nb "quoted"  ' },
      { t: 'close', link: 1 },
      { t: 'check', q: 7, url: URL_A, id: ID },
    ];
    for (const frame of frames) {
      expect(decodeClientFrame(encodeLinkFrame(frame))).toEqual({ ok: true, frame });
    }
  });

  it('round-trips every server frame', () => {
    const frames: ServerFrame[] = [
      { t: 'challenge', v: SHARED_LINK_VERSION, nonce: NONCE, proof: PROOF },
      { t: 'accept', v: SHARED_LINK_VERSION },
      { t: 'reject', reason: 'version' },
      { t: 'reject', reason: 'token' },
      { t: 'opened', link: 3 },
      { t: 'msg', link: 3, data: '["EOSE","s1"]' },
      { t: 'closed', link: 3, why: 'refused' },
      { t: 'checked', q: 7, outcome: 'missing' },
      { t: 'checked', q: 8, outcome: 'found', data: '{"id":"x"}' },
    ];
    for (const frame of frames) {
      expect(decodeServerFrame(encodeLinkFrame(frame))).toEqual({ ok: true, frame });
    }
  });

  it('carries relay text raw, without JSON escaping that could grow it past the limit', () => {
    const data = '"'.repeat(MAX_FRAME_BYTES - 10);
    const text = encodeLinkFrame({ t: 'send', link: 1, data });
    expect(text.length).toBeLessThan(MAX_FRAME_BYTES + 100);
    expect(decodeClientFrame(text)).toEqual({ ok: true, frame: { t: 'send', link: 1, data } });
  });

  it('refuses unknown, malformed and out-of-range frames with a fixed reason', () => {
    const secret = 'wss://secret-host.nostr-test.dev';
    const bad: unknown[] = [
      42,
      '',
      'not json',
      '{"t":"launch","link":1}',
      `{"t":"open","link":1,"url":"${secret}","extra":true}`,
      `{"t":"open","link":0,"url":"${secret}"}`,
      `{"t":"open","link":1.5,"url":"${secret}"}`,
      `{"t":"open","link":-1,"url":"${secret}"}`,
      '{"t":"open","link":1}',
      '{"t":"hello","v":1,"cli":"0.5.18","nonce":"short"}',
      `{"t":"hello","v":1,"cli":"0.5.18","token":"${NONCE}"}`,
      `{"t":"hello","v":1,"cli":"${'9'.repeat(100)}","nonce":"${NONCE}"}`,
      '{"t":"prove","proof":"zz"}',
      `{"t":"check","q":1,"url":"${secret}","id":"zz"}`,
      '{"t":"send","link":1}',
      '["send",1]',
    ];
    for (const text of bad) {
      const result = decodeClientFrame(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['malformed', 'unknown']).toContain(result.reason);
        expect(JSON.stringify(result)).not.toContain('secret');
      }
    }
    // A server frame is not a client frame, and the other way round.
    expect(decodeClientFrame(encodeLinkFrame({ t: 'opened', link: 1 })).ok).toBe(false);
    expect(decodeServerFrame(encodeLinkFrame({ t: 'open', link: 1, url: URL_A })).ok).toBe(false);
  });

  it('refuses a frame over the size limit before parsing it', () => {
    const data = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(decodeClientFrame(`{"t":"send","link":1}\n${data}`)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(decodeServerFrame(`{"t":"msg","link":1}\n${data}`)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(decodeClientFrame('x'.repeat(SHARED_LINK_MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('token proof (04 §4 "Local relay link")', () => {
  it('differs by side, by either nonce and by token, and never contains the token', () => {
    const token = new Uint8Array(32).fill(7);
    const other = new Uint8Array(32).fill(8);
    const cn = 'aa'.repeat(32);
    const sn = 'bb'.repeat(32);
    const server = linkProof(token, 'server', cn, sn);
    expect(server).toMatch(/^[0-9a-f]{64}$/);
    expect(linkProof(token, 'server', cn, sn)).toBe(server);
    expect(linkProof(token, 'client', cn, sn)).not.toBe(server);
    expect(linkProof(token, 'server', sn, cn)).not.toBe(server);
    expect(linkProof(other, 'server', cn, sn)).not.toBe(server);
    expect(server).not.toContain('07'.repeat(32));
    expect(checkLinkProof(token, 'server', cn, sn, server)).toBe(true);
    expect(checkLinkProof(token, 'client', cn, sn, server)).toBe(false);
    expect(checkLinkProof(token, 'server', cn, sn, 'zz')).toBe(false);
  });
});

describe('stream reader (length-prefixed frames)', () => {
  it('splits frames across chunk boundaries', () => {
    const a = encodeLinkFrame({ t: 'open', link: 1, url: URL_A });
    const b = encodeLinkFrame({ t: 'close', link: 1 });
    const bytes = new Uint8Array([...linkFrameBytes(a), ...linkFrameBytes(b)]);
    const reader = new LinkFrameReader();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      const result = reader.push(bytes.subarray(i, i + 3));
      expect(result.error).toBeUndefined();
      out.push(...result.frames);
    }
    expect(out).toEqual([a, b]);
  });

  it('refuses a declared length over the limit without buffering it, and stays refused', () => {
    const reader = new LinkFrameReader();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, SHARED_LINK_MAX_FRAME_BYTES + 1);
    expect(reader.push(header)).toEqual({ frames: [], error: 'too_large' });
    expect(reader.push(linkFrameBytes(encodeLinkFrame({ t: 'close', link: 1 })))).toEqual({
      frames: [],
      error: 'too_large',
    });
  });

  it('refuses a frame that is not UTF-8', () => {
    const reader = new LinkFrameReader();
    const bytes = new Uint8Array([0, 0, 0, 2, 0xff, 0xfe]);
    expect(reader.push(bytes)).toEqual({ frames: [], error: 'malformed' });
  });
});
