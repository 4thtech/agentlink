// Icon geometry for <Icon> (M1-35b). Generated once from the D1 reference bundle
// (docs/design/d1/components/reference/bundle.js) and kept as data, so icons render as React
// elements and never through innerHTML (Trusted Types, 08 §4).
//
// Sources: the 21 icons in CUSTOM_ICONS are AgentLink's own (docs/design/brand/icons/ui/);
// the other 36 are Lucide (ISC), see THIRD-PARTY-NOTICES.md.

export type IconShape = readonly [
  tag: 'path' | 'circle' | 'rect' | 'polyline' | 'polygon' | 'line' | 'ellipse',
  attrs: Readonly<Record<string, string>>,
];

export const CUSTOM_ICONS = [
  'proof-seal',
  'receipt-recorded',
  'receipt-delivered',
  'receipt-opened',
  'receipt-accepted',
  'receipt-rejected',
  'untrusted',
  'safety-code',
  'identity-selfdeclared',
  'identity-checked',
  'identity-registered',
  'identity-verified',
  'domain-warning',
  'commitment',
  'approval',
  'encrypted-drop',
  'own-storage',
  'agent',
  'ai-app',
  'cloud-agent',
  'browser-agent',
] as const;

export const ICON_SHAPES: Readonly<Record<string, readonly IconShape[]>> = {
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  copy: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
  ],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['polyline', { points: '12 6 12 12 16 14' }],
  ],
  'triangle-alert': [
    ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 16v-4' }],
    ['path', { d: 'M12 8h.01' }],
  ],
  file: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
  ],
  folder: [
    [
      'path',
      {
        d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
      },
    ],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '8' }],
    ['path', { d: 'm21 21-4.3-4.3' }],
  ],
  settings: [
    [
      'path',
      {
        d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
      },
    ],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  pause: [
    ['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }],
    ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }],
  ],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
  'refresh-cw': [
    ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
    ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
    ['path', { d: 'M8 16H3v5' }],
  ],
  download: [
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['polyline', { points: '7 10 12 15 17 10' }],
    ['line', {}],
  ],
  printer: [
    ['path', { d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' }],
    ['path', { d: 'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6' }],
    ['rect', { x: '6', y: '14', width: '12', height: '8', rx: '1' }],
  ],
  'user-plus': [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: '9', cy: '7', r: '4' }],
    ['line', {}],
    ['line', {}],
  ],
  ban: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm4.9 4.9 14.2 14.2' }],
  ],
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }],
  ],
  terminal: [
    ['polyline', { points: '4 17 10 11 4 5' }],
    ['line', {}],
  ],
  inbox: [
    ['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
    [
      'path',
      {
        d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
      },
    ],
  ],
  activity: [
    [
      'path',
      {
        d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
      },
    ],
  ],
  users: [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: '9', cy: '7', r: '4' }],
    ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }],
    ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
  ],
  'hard-drive': [
    ['line', {}],
    [
      'path',
      {
        d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
      },
    ],
    ['line', {}],
    ['line', {}],
  ],
  'sliders-horizontal': [
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
    ['line', {}],
  ],
  'wifi-off': [
    ['path', { d: 'M12 20h.01' }],
    ['path', { d: 'M8.5 16.429a5 5 0 0 1 7 0' }],
    ['path', { d: 'M5 12.859a10 10 0 0 1 5.17-2.69' }],
    ['path', { d: 'M19 12.859a10 10 0 0 0-2.007-1.523' }],
    ['path', { d: 'M2 8.82a15 15 0 0 1 4.177-2.643' }],
    ['path', { d: 'M22 8.82a15 15 0 0 0-11.288-3.764' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  ellipsis: [
    ['circle', { cx: '12', cy: '12', r: '1' }],
    ['circle', { cx: '19', cy: '12', r: '1' }],
    ['circle', { cx: '5', cy: '12', r: '1' }],
  ],
  circle: [['circle', { cx: '12', cy: '12', r: '10' }]],
  'circle-alert': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', {}],
    ['line', {}],
  ],
  'external-link': [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
  ],
  'arrow-right': [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'm12 5 7 7-7 7' }],
  ],
  'key-round': [
    [
      'path',
      {
        d: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
      },
    ],
    ['circle', { cx: '16.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
  ],
  'life-buoy': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm4.93 4.93 4.24 4.24' }],
    ['path', { d: 'm14.83 9.17 4.24-4.24' }],
    ['path', { d: 'm14.83 14.83 4.24 4.24' }],
    ['path', { d: 'm9.17 14.83-4.24 4.24' }],
    ['circle', { cx: '12', cy: '12', r: '4' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  'eye-off': [
    [
      'path',
      {
        d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
      },
    ],
    ['path', { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' }],
    [
      'path',
      {
        d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
      },
    ],
    ['path', { d: 'm2 2 20 20' }],
  ],
  'proof-seal': [
    ['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }],
    ['path', { d: 'M12 8.5 15.5 12 12 15.5 8.5 12Z' }],
  ],
  'receipt-recorded': [
    ['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }],
    ['path', { d: 'M12 8v4l2 2' }],
  ],
  'receipt-delivered': [
    ['path', { d: 'M12 3v10' }],
    ['path', { d: 'm8 9 4 4 4-4' }],
    ['path', { d: 'M4 15v5h16v-5' }],
  ],
  'receipt-opened': [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }],
    ['circle', { cx: '12', cy: '12', r: '2.5' }],
  ],
  'receipt-accepted': [
    ['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }],
    ['path', { d: 'm8.5 12 2.5 2.5 4.5-4.5' }],
  ],
  'receipt-rejected': [
    ['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z' }],
    ['path', { d: 'm9.5 9.5 5 5' }],
    ['path', { d: 'm14.5 9.5-5 5' }],
  ],
  untrusted: [
    ['path', { d: 'M4 8V4h4' }],
    ['path', { d: 'M16 4h4v4' }],
    ['path', { d: 'M20 16v4h-4' }],
    ['path', { d: 'M8 20H4v-4' }],
    ['path', { d: 'M9 10v2.5' }],
    ['path', { d: 'M15 10v2.5' }],
  ],
  'safety-code': [
    ['rect', { x: '2.5', y: '6', width: '19', height: '12', rx: '2' }],
    ['path', { d: 'M7 12h.01' }],
    ['path', { d: 'M10.3 12h.01' }],
    ['path', { d: 'M13.7 12h.01' }],
    ['path', { d: 'M17 12h.01' }],
  ],
  'identity-selfdeclared': [
    ['circle', { cx: '12', cy: '8', r: '4' }],
    ['path', { d: 'M4.5 20.5c.8-3.6 3.8-6 7.5-6s6.7 2.4 7.5 6', strokeDasharray: '2.5 2.5' }],
  ],
  'identity-checked': [
    ['circle', { cx: '10', cy: '8', r: '4' }],
    ['path', { d: 'M3 20.5c.7-3.4 3.5-6 7-6 1.3 0 2.5.3 3.5.9' }],
    ['path', { d: 'm15 18.5 2 2 4-4' }],
  ],
  'identity-registered': [
    ['circle', { cx: '10', cy: '8', r: '4' }],
    ['path', { d: 'M3 20.5c.7-3.4 3.5-6 7-6 1.3 0 2.5.3 3.5.9' }],
    ['path', { d: 'M18 14 21 17 18 20 15 17Z' }],
  ],
  'identity-verified': [
    ['path', { d: 'M17.4 11A7.5 7.5 0 1 0 10 17.5' }],
    ['path', { d: 'M2.5 10h15' }],
    ['path', { d: 'M10 2.5c2 2.1 3 4.6 3 7.5' }],
    ['path', { d: 'M10 2.5C8 4.6 7 7.1 7 10s1 5.4 3 7.5' }],
    ['path', { d: 'm14.5 18.5 2 2 4-4' }],
  ],
  'domain-warning': [
    ['path', { d: 'M17.4 10A7.5 7.5 0 1 0 10 17.5' }],
    ['path', { d: 'M2.5 10h11' }],
    ['path', { d: 'M10 2.5C8 4.6 7 7.1 7 10s1 5.4 3 7.5' }],
    ['path', { d: 'M19.5 13v4' }],
    ['path', { d: 'M19.5 20.5h.01' }],
  ],
  commitment: [
    [
      'path',
      { d: 'M14 2.5H6a1.5 1.5 0 0 0-1.5 1.5v16A1.5 1.5 0 0 0 6 21.5h12a1.5 1.5 0 0 0 1.5-1.5V8Z' },
    ],
    ['path', { d: 'M14 2.5V8h5.5' }],
    ['path', { d: 'M8.5 15.5h7' }],
    ['path', { d: 'M8.5 12h4' }],
  ],
  approval: [
    ['path', { d: 'M6.5 5.2A8 8 0 0 1 20 11v2' }],
    ['path', { d: 'M4 11a8 8 0 0 1 .6-3' }],
    ['path', { d: 'M4 15v-2' }],
    ['path', { d: 'M8 20v-7a4 4 0 0 1 8 0v2' }],
    ['path', { d: 'M12 13v8' }],
    ['path', { d: 'M16 19v2' }],
  ],
  'encrypted-drop': [
    [
      'path',
      {
        d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z',
      },
    ],
    ['path', { d: 'M12 11v5' }],
    ['path', { d: 'm9.5 13.5 2.5 2.5 2.5-2.5' }],
  ],
  'own-storage': [
    ['ellipse', { cx: '12', cy: '5.5', rx: '8', ry: '3' }],
    ['path', { d: 'M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13' }],
    ['path', { d: 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }],
  ],
  agent: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '2' }],
    ['path', { d: 'm7 9.5 3 2.5-3 2.5' }],
    ['path', { d: 'M12.5 15H17' }],
  ],
  'ai-app': [
    ['rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '2' }],
    ['path', { d: 'M2.5 9h19' }],
    ['path', { d: 'M6 6.5h.01' }],
    ['path', { d: 'M8.5 6.5h.01' }],
  ],
  'cloud-agent': [
    ['path', { d: 'M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9a4 4 0 0 1 .5 10Z' }],
    ['path', { d: 'm10 12 2.5 2-2.5 2' }],
  ],
  'browser-agent': [
    ['rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '2' }],
    ['path', { d: 'M2.5 9h19' }],
    ['path', { d: 'm7 12.5 2.5 2-2.5 2' }],
    ['path', { d: 'M12 16.5h4' }],
  ],
};
