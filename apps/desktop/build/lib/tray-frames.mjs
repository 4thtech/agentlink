// Tray animation frames from the brand mark (two brackets and a diamond, 16x16 grid).
// Pure Node: the same geometry feeds the SVG sources and a small supersampling rasteriser, so the
// output is byte-for-byte deterministic. No dependencies. The brand art lives in
// docs/design/brand/icons/tray; calm motion rules in docs/design/claude-design-handoff.md 4.4-4.6.
import { deflateSync } from 'node:zlib';

export const FRAME_MS = 40;
const SS = 8; // supersamples per pixel edge

// ---------- geometry ----------
const R = (n) => Math.round(n * 1000) / 1000;
const LEFT = [[1, 1.5], [5, 1.5], [5, 3.5], [3, 3.5], [3, 12.5], [5, 12.5], [5, 14.5], [1, 14.5]];
const RIGHT = [[15, 1.5], [11, 1.5], [11, 3.5], [13, 3.5], [13, 12.5], [11, 12.5], [11, 14.5], [15, 14.5]];
const DIAMOND = [[8, 4.5], [11.5, 8], [8, 11.5], [4.5, 8]];

function arcPoints() {
  // The approvals right bracket: A3.8 3.8 from (13, 8.6) to (15, 8.9), centre above the chord.
  const [x1, y1, x2, y2, r] = [13, 8.6, 15, 8.9, 3.8];
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const c = Math.hypot(dx, dy);
  const h = Math.sqrt(r * r - (c / 2) ** 2);
  const cx = mx + (dy / c) * h;
  const cy = my - (dx / c) * h;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  if (a2 > a1) a2 -= 2 * Math.PI;
  const pts = [];
  for (let i = 1; i < 6; i++) {
    const a = a1 + ((a2 - a1) * i) / 6;
    pts.push([R(cx + r * Math.cos(a)), R(cy + r * Math.sin(a))]);
  }
  return pts;
}
const RIGHT_CUT = [[15, 14.5], [11, 14.5], [11, 12.5], [13, 12.5], [13, 8.6], ...arcPoints(), [15, 8.9]];
const RIGHT_UPDATE = [[15, 1.5], [11, 1.5], [11, 3.5], [13, 3.5], [13, 7], [15, 7]];
const ARROW = [[12, 9.5], [12, 12], [10.5, 12], [13, 15], [15.5, 12], [14, 12], [14, 9.5]];
const HOLE = [[8, 6.6], [6.6, 8], [8, 9.4], [9.4, 8]];
const circle = (cx, cy, r, n = 40) =>
  Array.from({ length: n }, (_, i) => [
    R(cx + r * Math.cos((2 * Math.PI * i) / n)),
    R(cy + r * Math.sin((2 * Math.PI * i) / n)),
  ]);
// The offline slash: stroke (2,14)-(14,2), width 1.6, butt caps.
const SLASH = (() => {
  const n = 0.8 * Math.SQRT1_2;
  return [[2 - n, 14 - n], [2 + n, 14 + n], [14 + n, 2 + n], [14 - n, 2 - n]].map(([x, y]) => [R(x), R(y)]);
})();

// Sutherland-Hodgman against x >= lo and x <= hi.
function clipX(poly, lo, hi) {
  const edge = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(cut(a, b));
    }
    return out;
  };
  const at = (x) => (a, b) => [R(x), R(a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]))];
  const p = edge(poly, (q) => q[0] >= lo, at(lo));
  return p.length ? edge(p, (q) => q[0] <= hi, at(hi)) : p;
}

/** The diamond moved by (dx, 0) and scaled about its centre (8, 8), then clipped to the 16 px frame. */
function diamond(dx = 0, scale = 1) {
  const pts = DIAMOND.map(([x, y]) => [R(8 + (x - 8) * scale + dx), R(8 + (y - 8) * scale)]);
  return clipX(pts, 0, 16);
}

const shape = (subs, extra = {}) => ({ subs, rule: 'nonzero', opacity: 1, layer: 'content', ...extra });
const base = (right = RIGHT) => [shape([LEFT]), shape([right])];
const connected = (d = {}) => [...base(), shape([diamond(d.dx ?? 0, d.scale ?? 1)])];
// The unread dot: a gap is cut around it, then the dot is drawn on top.
const withDot = (shapes) => [
  ...shapes,
  shape([circle(13, 3, 3.4)], { layer: 'erase' }),
  shape([circle(13, 3, 2.2)], { layer: 'overlay' }),
];
const approvals = (scale = 1) => [
  ...base(RIGHT_CUT),
  shape([diamond(0, scale)]),
  shape([circle(13, 3, 2.6)], { layer: 'overlay' }),
];

const STATIC = {
  connected: connected(),
  'connected-unread': withDot(connected()),
  approvals: approvals(),
  paused: [...base(), shape([DIAMOND, HOLE], { rule: 'evenodd' })],
  offline: [...base(), shape([DIAMOND], { opacity: 0.35 }), shape([SLASH])],
  update: [shape([LEFT]), shape([RIGHT_UPDATE]), shape([DIAMOND]), shape([ARROW])],
};

const easeOut = (t) => 1 - (1 - t) ** 3;

function sequences() {
  return {
    // The diamond slides in from the right edge (clipped by the frame), settles, then the dot lands.
    'msg-in': {
      loop: false,
      frames: [
        ...Array.from({ length: 7 }, (_, i) => connected({ dx: 9 * (1 - easeOut(i / 6)) })),
        withDot(connected()),
      ],
    },
    // Out to the right and back.
    'msg-out': {
      loop: false,
      frames: Array.from({ length: 8 }, (_, i) =>
        connected({ dx: i === 7 ? 0 : 9 * Math.sin(Math.PI * easeOut(i / 7)) ** 2 }),
      ),
    },
    // A small swell, settling in the approvals mark.
    approval: {
      loop: false,
      frames: [connected(), approvals(1.12), approvals(1.25), approvals(1.15), approvals(1.05), approvals(1)],
    },
    // The diamond breathes between 0.8 and 1.0; the only loop.
    connecting: {
      loop: true,
      frames: Array.from({ length: 8 }, (_, i) =>
        connected({ scale: R(0.9 + 0.1 * Math.cos((2 * Math.PI * i) / 8)) }),
      ),
    },
    static: { loop: false, frames: Object.values(STATIC), ids: Object.keys(STATIC) },
  };
}

/** Every frame: [{ id, sequence, index, loop, shapes }] in manifest order. */
export function allFrames() {
  const out = [];
  for (const [name, s] of Object.entries(sequences())) {
    s.frames.forEach((shapes, index) =>
      out.push({
        id: s.ids ? `tray-${s.ids[index]}` : `${name}-${index}`,
        sequence: name,
        index,
        loop: s.loop,
        shapes,
      }),
    );
  }
  return out;
}

// ---------- SVG ----------
const pathD = (subs) => subs.map((p) => 'M' + p.map(([x, y]) => `${R(x)} ${R(y)}`).join('L') + 'Z').join(' ');
export function toSvg(frame) {
  const el = (s, fill = '#000000') =>
    `<path fill="${fill}"${s.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${
      s.opacity !== 1 ? ` opacity="${s.opacity}"` : ''
    } d="${pathD(s.subs)}"/>`;
  const content = frame.shapes.filter((s) => s.layer === 'content').map((s) => el(s)).join('');
  const erase = frame.shapes.filter((s) => s.layer === 'erase');
  const overlay = frame.shapes.filter((s) => s.layer === 'overlay').map((s) => el(s)).join('');
  const mask = erase.length
    ? `<mask id="m"><rect width="16" height="16" fill="#fff"/>${erase.map((s) => el(s, '#000')).join('')}</mask>`
    : '';
  const body = erase.length ? `<g mask="url(#m)">${content}</g>` : content;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><title>AgentLink tray: ${frame.id}</title>${mask}${body}${overlay}</svg>\n`;
}

// ---------- raster ----------
function inside(subs, rule, x, y) {
  let winding = 0;
  let crossings = 0;
  for (const p of subs) {
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i];
      const [x2, y2] = p[(i + 1) % p.length];
      if (y1 <= y !== y2 <= y) {
        const xi = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
        if (xi > x) {
          crossings++;
          winding += y2 > y1 ? 1 : -1;
        }
      }
    }
  }
  return rule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

/** Alpha coverage (0..1) of a frame at `size` px square, supersampled. */
export function coverage(frame, size) {
  const k = 16 / size;
  const out = new Float32Array(size * size);
  const order = ['content', 'erase', 'overlay'].flatMap((l) =>
    frame.shapes.filter((s) => s.layer === l).map((s) => [l, s]),
  );
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * k;
          const y = (py + (sy + 0.5) / SS) * k;
          let a = 0;
          for (const [layer, s] of order) {
            const hit = inside(s.subs, s.rule, x, y);
            if (layer === 'erase') {
              if (hit) a = 0;
            } else if (hit) a = a + (1 - a) * s.opacity;
          }
          sum += a;
        }
      }
      out[py * size + px] = sum / (SS * SS);
    }
  }
  return out;
}

// ---------- PNG ----------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** RGBA PNG; `rgba(x, y)` returns [r, g, b, a] bytes. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) Buffer.from(rgba(x, y)).copy(raw, o + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Single-colour PNG with the coverage as alpha (black for macOS templates). */
export function framePng(frame, size, colour = 0) {
  const cov = coverage(frame, size);
  return encodePng(size, size, (x, y) => [colour, colour, colour, Math.round(cov[y * size + x] * 255)]);
}

/** Contact sheet: one row per sequence, `scale` x 16 px per frame, light half then dark half. */
export function contactSheet(frames, scale = 8) {
  const cell = 16 * scale;
  const pad = 16;
  const cols = 8;
  const rows = [...new Set(frames.map((f) => f.sequence))];
  const half = rows.length * (cell + pad) + pad;
  const W = cols * (cell + pad) + pad;
  const H = half * 2;
  const buf = Buffer.alloc(W * H * 4);
  const bgs = [[238, 238, 240], [28, 28, 32]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf.set([...bgs[y < half ? 0 : 1], 255], (y * W + x) * 4);
  for (const f of frames) {
    const r = rows.indexOf(f.sequence);
    const cov = coverage(f, cell);
    for (let h = 0; h < 2; h++) {
      const ox = pad + f.index * (cell + pad);
      const oy = h * half + pad + r * (cell + pad);
      const ink = h ? 245 : 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const a = cov[y * cell + x];
          const o = ((oy + y) * W + ox + x) * 4;
          for (let i = 0; i < 3; i++) buf[o + i] = Math.round(buf[o + i] * (1 - a) + ink * a);
        }
      }
    }
  }
  return encodePng(W, H, (x, y) => buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
}
