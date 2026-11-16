// TRAY-ENGINE: the tray frames from apps/desktop/assets/tray/manifest.json (src/main/tray-frames.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRAY_FRAMES_DIR,
  TrayFrames,
  engineSequences,
  loadTrayFrames,
  parseTrayManifest,
  trayFramesDir,
  type TrayImage,
  type TrayImageModule,
} from '../../src/main/tray-frames.js';
import { STATIC_FRAMES } from '../../src/main/tray-engine.js';

const ASSETS = resolve(__dirname, '..', '..', 'assets', 'tray');
const REAL = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as unknown;

class Img implements TrayImage {
  template = false;
  reps: { scaleFactor: number; buffer: Uint8Array }[] = [];
  constructor(
    readonly source: string,
    readonly empty: boolean,
  ) {}
  isEmpty(): boolean {
    return this.empty && this.reps.length === 0;
  }
  setTemplateImage(template: boolean): void {
    this.template = template;
  }
  addRepresentation(options: { scaleFactor: number; buffer: Uint8Array }): void {
    this.reps.push(options);
  }
}

function fakeImages(existing: (path: string) => boolean) {
  const created: Img[] = [];
  const module: TrayImageModule = {
    createFromPath: (path) => {
      const img = new Img(path, !existing(path));
      created.push(img);
      return img;
    },
    createFromBuffer: (buffer, options) => {
      const img = new Img(`buffer:${options?.scaleFactor ?? 1}`, buffer.length === 0);
      if (buffer.length > 0) img.reps.push({ scaleFactor: options?.scaleFactor ?? 1, buffer });
      created.push(img);
      return img;
    },
  };
  return { module, created };
}

const builtin = () => new Img('builtin', false);

describe('parseTrayManifest', () => {
  it('reads the real manifest and every sequence the engine needs', () => {
    const manifest = parseTrayManifest(REAL);
    const seqs = engineSequences(manifest);
    expect(seqs.connecting.loop).toBe(true);
    expect(seqs['msg-in'].loop).toBe(false);
    expect(seqs['msg-out'].frames.length).toBeGreaterThan(0);
    expect(seqs.approval.frames.length).toBeGreaterThan(0);
    for (const s of Object.values(seqs)) expect(s.frameMs).toBeGreaterThanOrEqual(16);
    const ids = new Set(manifest.frames.keys());
    for (const id of Object.values(STATIC_FRAMES)) expect(ids.has(id)).toBe(true);
  });

  it('every file the real manifest names exists', () => {
    const manifest = parseTrayManifest(REAL);
    for (const frame of manifest.frames.values()) {
      for (const p of [...frame.macos, ...frame.windows.dark, ...frame.windows.light]) {
        expect(existsSync(join(ASSETS, p)), p).toBe(true);
      }
    }
  });

  it('refuses paths that leave the tray folder or are not PNGs', () => {
    const bad = (path: string) => ({
      frameMs: 40,
      sizes: { macos: [16, 32], windows: [16, 32] },
      sequences: {
        static: {
          loop: false,
          frameMs: 40,
          frames: [
            {
              id: 'tray-connected',
              macos: [path, 'macos/a@2x.png'],
              windows: { dark: ['windows/a.png', 'windows/b.png'], light: ['windows/c.png', 'windows/d.png'] },
            },
          ],
        },
      },
    });
    for (const p of ['../evil.png', '/etc/passwd', 'macos/../../x.png', 'macos/a.svg', 'macos\\a.png', '']) {
      expect(() => parseTrayManifest(bad(p)), p).toThrow();
    }
    expect(() => parseTrayManifest(bad('macos/aTemplate.png'))).not.toThrow();
  });

  it('refuses a malformed manifest', () => {
    expect(() => parseTrayManifest(null)).toThrow();
    expect(() => parseTrayManifest({ sequences: [] })).toThrow();
    expect(() => parseTrayManifest({ frameMs: 40, sequences: { connecting: { loop: 'yes', frames: [] } } })).toThrow();
  });
});

describe('TrayFrames', () => {
  const manifest = parseTrayManifest(REAL);

  it('macOS: the Template PNG (Electron adds @2x), marked as a template image', () => {
    const { module } = fakeImages(() => true);
    const frames = new TrayFrames({ manifest, dir: '/res/assets/tray', platform: 'darwin', nativeImage: module, fallback: builtin });
    const img = frames.image('msg-in-3', 'tray-connected', 'light') as Img;
    expect(img.source).toBe(join('/res/assets/tray', 'macos', 'msg-in-3Template.png'));
    expect(img.template).toBe(true);
    // Cached: the same object the second time.
    expect(frames.image('msg-in-3', 'tray-connected', 'dark')).toBe(img);
  });

  it('Windows: the light or dark taskbar set, 16 px at 1x and 32 px at 2x, never a template', () => {
    const { module } = fakeImages(() => true);
    const read: string[] = [];
    const frames = new TrayFrames({
      manifest,
      dir: 'C:\\res\\assets\\tray',
      platform: 'win32',
      nativeImage: module,
      fallback: builtin,
      readFile: (p) => {
        read.push(p);
        return new Uint8Array([1, 2, 3]);
      },
    });
    const dark = frames.image('tray-connected', 'tray-connected', 'dark') as Img;
    const light = frames.image('tray-connected', 'tray-connected', 'light') as Img;
    expect(dark).not.toBe(light);
    expect(dark.template).toBe(false);
    expect(dark.reps.map((r) => r.scaleFactor)).toEqual([1, 2]);
    expect(read.some((p) => p.includes('tray-connected-dark-taskbar-16.png'))).toBe(true);
    expect(read.some((p) => p.includes('tray-connected-light-taskbar-32.png'))).toBe(true);
  });

  it('a missing frame falls back to the static variant, then the built-in image', () => {
    const { module } = fakeImages((p) => !p.includes('msg-in-2'));
    const frames = new TrayFrames({ manifest, dir: '/r', platform: 'darwin', nativeImage: module, fallback: builtin });
    expect((frames.image('msg-in-2', 'tray-connected-unread', 'dark') as Img).source).toContain('tray-connected-unreadTemplate.png');
    expect((frames.image('no-such-frame', 'tray-offline', 'dark') as Img).source).toContain('tray-offlineTemplate.png');

    const none = fakeImages(() => false);
    const empty = new TrayFrames({ manifest, dir: '/r', platform: 'darwin', nativeImage: none.module, fallback: builtin });
    const img = empty.image('msg-in-2', 'tray-connected', 'dark') as Img;
    expect(img.source).toBe('builtin');
  });

  it('Windows: an unreadable file falls back too (no throw)', () => {
    const { module } = fakeImages(() => true);
    const frames = new TrayFrames({
      manifest,
      dir: '/r',
      platform: 'win32',
      nativeImage: module,
      fallback: builtin,
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect((frames.image('approval-1', 'tray-approvals', 'dark') as Img).source).toBe('builtin');
  });
});

describe('loadTrayFrames', () => {
  it('reads manifest.json from the folder; null when it is missing or bad', () => {
    const { module } = fakeImages(() => true);
    const ok = loadTrayFrames({
      dir: ASSETS,
      platform: 'darwin',
      nativeImage: module,
      fallback: builtin,
    });
    expect(ok).not.toBeNull();
    expect(ok?.sequences.connecting.loop).toBe(true);
    expect(
      loadTrayFrames({ dir: '/nowhere', platform: 'darwin', nativeImage: module, fallback: builtin }),
    ).toBeNull();
    expect(
      loadTrayFrames({
        dir: '/x',
        platform: 'darwin',
        nativeImage: module,
        fallback: builtin,
        readFile: () => new TextEncoder().encode('{not json'),
      }),
    ).toBeNull();
  });

  it('the packaged folder is <resources>/assets/tray', () => {
    expect(TRAY_FRAMES_DIR).toEqual(['assets', 'tray']);
    expect(trayFramesDir('/Applications/AgentLink.app/Contents/Resources')).toBe(
      join('/Applications/AgentLink.app/Contents/Resources', 'assets', 'tray'),
    );
  });
});
