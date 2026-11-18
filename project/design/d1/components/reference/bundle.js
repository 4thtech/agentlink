/* @ds-bundle: {"format":4,"namespace":"AgentLink","components":[{"name":"Mark"},{"name":"Wordmark"},{"name":"Lockup"},{"name":"Icon"},{"name":"Button"},{"name":"Kbd"},{"name":"TextField"},{"name":"Switch"},{"name":"Segmented"},{"name":"StatusChip"},{"name":"IdentityLabel"},{"name":"Fingerprint"},{"name":"ContactName"},{"name":"SafetyCode"},{"name":"ContactCard"},{"name":"UntrustedContent"},{"name":"ApprovalCard"},{"name":"TermsDiff"},{"name":"CommitmentCard"},{"name":"ProofBadge"},{"name":"ReceiptTimeline"},{"name":"CostChip"},{"name":"CreditsMeter"},{"name":"FileCard"},{"name":"CopyPrompt"},{"name":"SecretDisplay"},{"name":"Banner"},{"name":"Toast"},{"name":"EmptyState"},{"name":"AppShell"},{"name":"TrayMenu"}]} */
(function () {
  var R = window.React, h = R.createElement, F = R.Fragment;
  var ICONS = {"check":"<path d=\"M20 6 9 17l-5-5\" />","x":"<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />","copy":"<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />","clock":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <polyline points=\"12 6 12 12 16 14\" />","triangle-alert":"<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /> <path d=\"M12 9v4\" /> <path d=\"M12 17h.01\" />","info":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 16v-4\" /> <path d=\"M12 8h.01\" />","file":"<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" />","folder":"<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" />","search":"<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />","settings":"<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />","chevron-right":"<path d=\"m9 18 6-6-6-6\" />","chevron-down":"<path d=\"m6 9 6 6 6-6\" />","pause":"<rect x=\"14\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" /> <rect x=\"6\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\" />","play":"<polygon points=\"6 3 20 12 6 21 6 3\" />","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />","download":"<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <polyline points=\"7 10 12 15 17 10\" /> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />","printer":"<path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\" /> <path d=\"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6\" /> <rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\" />","user-plus":"<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /> <circle cx=\"9\" cy=\"7\" r=\"4\" /> <line x1=\"19\" x2=\"19\" y1=\"8\" y2=\"14\" /> <line x1=\"22\" x2=\"16\" y1=\"11\" y2=\"11\" />","ban":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m4.9 4.9 14.2 14.2\" />","plus":"<path d=\"M5 12h14\" /> <path d=\"M12 5v14\" />","terminal":"<polyline points=\"4 17 10 11 4 5\" /> <line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\" />","inbox":"<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\" /> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" />","activity":"<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />","users":"<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /> <circle cx=\"9\" cy=\"7\" r=\"4\" /> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /> <path d=\"M16 3.13a4 4 0 0 1 0 7.75\" />","hard-drive":"<line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\" /> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" /> <line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\" /> <line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\" />","sliders-horizontal":"<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\" /> <line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\" /> <line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\" /> <line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\" /> <line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\" /> <line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\" /> <line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\" /> <line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\" /> <line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\" />","wifi-off":"<path d=\"M12 20h.01\" /> <path d=\"M8.5 16.429a5 5 0 0 1 7 0\" /> <path d=\"M5 12.859a10 10 0 0 1 5.17-2.69\" /> <path d=\"M19 12.859a10 10 0 0 0-2.007-1.523\" /> <path d=\"M2 8.82a15 15 0 0 1 4.177-2.643\" /> <path d=\"M22 8.82a15 15 0 0 0-11.288-3.764\" /> <path d=\"m2 2 20 20\" />","ellipsis":"<circle cx=\"12\" cy=\"12\" r=\"1\" /> <circle cx=\"19\" cy=\"12\" r=\"1\" /> <circle cx=\"5\" cy=\"12\" r=\"1\" />","circle":"<circle cx=\"12\" cy=\"12\" r=\"10\" />","circle-alert":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\" /> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\" />","external-link":"<path d=\"M15 3h6v6\" /> <path d=\"M10 14 21 3\" /> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />","arrow-right":"<path d=\"M5 12h14\" /> <path d=\"m12 5 7 7-7 7\" />","key-round":"<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />","life-buoy":"<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m4.93 4.93 4.24 4.24\" /> <path d=\"m14.83 9.17 4.24-4.24\" /> <path d=\"m14.83 14.83 4.24 4.24\" /> <path d=\"m9.17 14.83-4.24 4.24\" /> <circle cx=\"12\" cy=\"12\" r=\"4\" />","minus":"<path d=\"M5 12h14\" />","eye-off":"<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\" /> <path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\" /> <path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\" /> <path d=\"m2 2 20 20\" />","proof-seal":"<path d=\"M12 2.5 21.5 12 12 21.5 2.5 12Z\"/><path d=\"M12 8.5 15.5 12 12 15.5 8.5 12Z\"/>","receipt-recorded":"<path d=\"M12 2.5 21.5 12 12 21.5 2.5 12Z\"/><path d=\"M12 8v4l2 2\"/>","receipt-delivered":"<path d=\"M12 3v10\"/><path d=\"m8 9 4 4 4-4\"/><path d=\"M4 15v5h16v-5\"/>","receipt-opened":"<path d=\"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/>","receipt-accepted":"<path d=\"M12 2.5 21.5 12 12 21.5 2.5 12Z\"/><path d=\"m8.5 12 2.5 2.5 4.5-4.5\"/>","receipt-rejected":"<path d=\"M12 2.5 21.5 12 12 21.5 2.5 12Z\"/><path d=\"m9.5 9.5 5 5\"/><path d=\"m14.5 9.5-5 5\"/>","untrusted":"<path d=\"M4 8V4h4\"/><path d=\"M16 4h4v4\"/><path d=\"M20 16v4h-4\"/><path d=\"M8 20H4v-4\"/><path d=\"M9 10v2.5\"/><path d=\"M15 10v2.5\"/>","safety-code":"<rect x=\"2.5\" y=\"6\" width=\"19\" height=\"12\" rx=\"2\"/><path d=\"M7 12h.01\"/><path d=\"M10.3 12h.01\"/><path d=\"M13.7 12h.01\"/><path d=\"M17 12h.01\"/>","identity-selfdeclared":"<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4.5 20.5c.8-3.6 3.8-6 7.5-6s6.7 2.4 7.5 6\" stroke-dasharray=\"2.5 2.5\"/>","identity-checked":"<circle cx=\"10\" cy=\"8\" r=\"4\"/><path d=\"M3 20.5c.7-3.4 3.5-6 7-6 1.3 0 2.5.3 3.5.9\"/><path d=\"m15 18.5 2 2 4-4\"/>","identity-registered":"<circle cx=\"10\" cy=\"8\" r=\"4\"/><path d=\"M3 20.5c.7-3.4 3.5-6 7-6 1.3 0 2.5.3 3.5.9\"/><path d=\"M18 14 21 17 18 20 15 17Z\"/>","identity-verified":"<path d=\"M17.4 11A7.5 7.5 0 1 0 10 17.5\"/><path d=\"M2.5 10h15\"/><path d=\"M10 2.5c2 2.1 3 4.6 3 7.5\"/><path d=\"M10 2.5C8 4.6 7 7.1 7 10s1 5.4 3 7.5\"/><path d=\"m14.5 18.5 2 2 4-4\"/>","domain-warning":"<path d=\"M17.4 10A7.5 7.5 0 1 0 10 17.5\"/><path d=\"M2.5 10h11\"/><path d=\"M10 2.5C8 4.6 7 7.1 7 10s1 5.4 3 7.5\"/><path d=\"M19.5 13v4\"/><path d=\"M19.5 20.5h.01\"/>","commitment":"<path d=\"M14 2.5H6a1.5 1.5 0 0 0-1.5 1.5v16A1.5 1.5 0 0 0 6 21.5h12a1.5 1.5 0 0 0 1.5-1.5V8Z\"/><path d=\"M14 2.5V8h5.5\"/><path d=\"M8.5 15.5h7\"/><path d=\"M8.5 12h4\"/>","approval":"<path d=\"M6.5 5.2A8 8 0 0 1 20 11v2\"/><path d=\"M4 11a8 8 0 0 1 .6-3\"/><path d=\"M4 15v-2\"/><path d=\"M8 20v-7a4 4 0 0 1 8 0v2\"/><path d=\"M12 13v8\"/><path d=\"M16 19v2\"/>","encrypted-drop":"<path d=\"M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z\"/><path d=\"M12 11v5\"/><path d=\"m9.5 13.5 2.5 2.5 2.5-2.5\"/>","own-storage":"<ellipse cx=\"12\" cy=\"5.5\" rx=\"8\" ry=\"3\"/><path d=\"M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13\"/><path d=\"M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3\"/>","agent":"<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"16\" rx=\"2\"/><path d=\"m7 9.5 3 2.5-3 2.5\"/><path d=\"M12.5 15H17\"/>","ai-app":"<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"16\" rx=\"2\"/><path d=\"M2.5 9h19\"/><path d=\"M6 6.5h.01\"/><path d=\"M8.5 6.5h.01\"/>","cloud-agent":"<path d=\"M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9a4 4 0 0 1 .5 10Z\"/><path d=\"m10 12 2.5 2-2.5 2\"/>","browser-agent":"<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"16\" rx=\"2\"/><path d=\"M2.5 9h19\"/><path d=\"m7 12.5 2.5 2-2.5 2\"/><path d=\"M12 16.5h4\"/>"};
  var WM = {"d":"M9.32 -28.400000000000002H14.68L23.16 0.0H18.56L16.64 -6.72H7.36L5.44 0.0H0.84ZM15.48 -10.64 12.0 -22.8 8.52 -10.64Z M25.72 0.32 30.16 0.0Q30.64 1.4000000000000001 31.700000000000003 2.06Q32.760000000000005 2.72 34.68 2.72Q37.2 2.72 38.540000000000006 1.6Q39.88 0.48 39.88 -1.76V-4.5600000000000005Q39.120000000000005 -2.96 37.56 -2.04Q36.0 -1.12 33.88 -1.12Q31.28 -1.12 29.28 -2.42Q27.28 -3.72 26.16 -6.04Q25.04 -8.36 25.04 -11.36Q25.04 -14.48 26.14 -16.86Q27.240000000000002 -19.240000000000002 29.220000000000002 -20.54Q31.200000000000003 -21.84 33.760000000000005 -21.84Q35.88 -21.84 37.540000000000006 -20.84Q39.2 -19.84 39.96 -18.04L40.040000000000006 -21.36H44.16V-2.2Q44.16 2.0 41.68 4.24Q39.2 6.48 34.68 6.48Q31.16 6.48 28.8 4.82Q26.44 3.16 25.72 0.32ZM39.88 -11.48Q39.88 -14.44 38.46 -16.18Q37.04 -17.92 34.68 -17.92Q32.28 -17.92 30.92 -16.18Q29.560000000000002 -14.44 29.560000000000002 -11.36Q29.560000000000002 -8.32 30.94 -6.5600000000000005Q32.32 -4.8 34.68 -4.8Q37.08 -4.8 38.480000000000004 -6.58Q39.88 -8.36 39.88 -11.48Z M47.88 -10.68Q47.88 -14.040000000000001 49.1 -16.560000000000002Q50.32 -19.080000000000002 52.56 -20.46Q54.800000000000004 -21.84 57.72 -21.84Q60.480000000000004 -21.84 62.7 -20.54Q64.92 -19.240000000000002 66.18 -16.700000000000003Q67.44 -14.16 67.44 -10.6V-9.56H52.4Q52.64 -6.5600000000000005 54.04 -5.0Q55.44 -3.44 57.800000000000004 -3.44Q59.56 -3.44 60.760000000000005 -4.3Q61.96 -5.16 62.52 -6.72L67.04 -6.32Q66.08 -3.24 63.66 -1.3800000000000001Q61.24 0.48 57.800000000000004 0.48Q54.84 0.48 52.58 -0.9000000000000001Q50.32 -2.2800000000000002 49.1 -4.800000000000001Q47.88 -7.32 47.88 -10.68ZM57.72 -17.92Q55.6 -17.92 54.24 -16.580000000000002Q52.88 -15.24 52.480000000000004 -12.72H62.760000000000005Q62.480000000000004 -15.24 61.14 -16.580000000000002Q59.800000000000004 -17.92 57.72 -17.92Z M72.12 -21.36H76.0L76.12 -17.6Q76.92 -19.72 78.58000000000001 -20.78Q80.24000000000001 -21.84 82.44000000000001 -21.84Q85.80000000000001 -21.84 87.56 -19.64Q89.32000000000001 -17.44 89.32000000000001 -13.8V0.0H85.04V-12.64Q85.04 -15.44 84.12 -16.8Q83.2 -18.16 81.16000000000001 -18.16Q79.04 -18.16 77.72 -16.66Q76.4 -15.16 76.4 -12.48V0.0H72.12Z M99.60000000000001 -6.4V-17.68H93.04V-21.36H99.60000000000001V-26.76H103.88V-21.36H112.32000000000001V-17.68H103.88V-6.6000000000000005Q103.88 -3.68 106.72 -3.68H112.32000000000001V0.0H106.2Q102.84 0.0 101.22 -1.56Q99.60000000000001 -3.12 99.60000000000001 -6.4Z M117.84 -28.400000000000002H122.24V-4.04H135.76V0.0H117.84Z M139.68 -3.68H148.04000000000002V-17.68H140.08V-21.36H152.36V-3.68H159.52V0.0H139.68ZM147.8 -28.52H152.28000000000003V-24.28H147.8Z M163.32 -21.36H167.2L167.32 -17.6Q168.12 -19.72 169.78 -20.78Q171.44 -21.84 173.64 -21.84Q177.0 -21.84 178.76 -19.64Q180.51999999999998 -17.44 180.51999999999998 -13.8V0.0H176.24V-12.64Q176.24 -15.44 175.32 -16.8Q174.4 -18.16 172.35999999999999 -18.16Q170.24 -18.16 168.92000000000002 -16.66Q167.6 -15.16 167.6 -12.48V0.0H163.32Z M185.6 -28.400000000000002H189.88V-11.08L199.12 -21.36H204.48000000000002L196.12 -12.280000000000001L204.84 0.0H199.64000000000001L193.28 -9.36L189.88 -5.68V0.0H185.6Z","w":206.4,"h":38,"cap":29};
  function cx() { var o = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) o.push(arguments[i]); return o.join(' '); }
  function rest(p, keys) { var o = {}; for (var k in p) if (keys.indexOf(k) < 0) o[k] = p[k]; return o; }

  /* ---------- name rule (handoff 5.3) ---------- */
  var RESERVED = ['verified', 'registered', 'self-declared', 'selfdeclared', 'safety code', 'checked', 'agentlink', 'system', 'approved', 'owner'];
  function formatContactName(c) {
    c = c || {};
    if (c.alias) return { kind: 'alias', text: c.alias };
    var n = (c.name || '').normalize ? (c.name || '').normalize('NFC') : (c.name || '');
    var lower = n.toLowerCase();
    var reserved = RESERVED.some(function (w) { return lower.indexOf(w) >= 0; });
    var latin = /^[A-Za-zÀ-ɏ0-9 .'’-]+$/.test(n);
    if (!n || reserved || !latin) return { kind: 'fingerprint', text: 'Contact ' + (c.fingerprint || '—') };
    var r = n.replace(/[^A-Za-zÀ-ɏ0-9 .'’-]/g, '').slice(0, 32);
    return { kind: 'restricted', text: '“' + r + '”' };
  }

  /* ---------- brand ---------- */
  function Mark(p) {
    var size = p.size || 24, mono = p.mono;
    var small = size <= 20;
    var t = p.title || 'AgentLink';
    if (small) {
      return h('svg', { className: cx('al-mark', p.className), width: size, height: size, viewBox: '0 0 16 16', role: 'img', 'aria-label': t },
        h('path', { className: 'al-mark-ink', d: 'M1 1.5H5V3.5H3V12.5H5V14.5H1Z M15 1.5H11V3.5H13V12.5H11V14.5H15Z' }),
        h('path', { className: mono ? 'al-mark-ink' : 'al-mark-seal', d: 'M8 4.5L11.5 8L8 11.5L4.5 8Z' }));
    }
    return h('svg', { className: cx('al-mark', p.className), width: size * 38 / 36, height: size, viewBox: '5 6 38 36', role: 'img', 'aria-label': t },
      h('path', { className: 'al-mark-ink', d: 'M5 6H15.5V11H10V37H15.5V42H5Z M43 6H32.5V11H38V37H32.5V42H43Z' }),
      h('path', { className: mono ? 'al-mark-ink' : 'al-mark-seal', d: 'M24 15L33 24L24 33L15 24Z' }));
  }
  function Wordmark(p) {
    var hgt = p.height || 20;
    return h('svg', { className: cx('al-wordmark', p.className), height: hgt, width: hgt * WM.w / WM.h, viewBox: '0 0 ' + WM.w + ' ' + WM.h, role: 'img', 'aria-label': p.productName || 'AgentLink' },
      h('path', { transform: 'translate(0 ' + WM.cap + ')', d: WM.d }));
  }
  function Lockup(p) {
    var s = p.size || 24, layout = p.layout || 'horizontal';
    return h('span', { className: cx('al-lockup', 'al-lockup-' + layout, p.mono && 'al-lockup-mono', p.className), role: 'img', 'aria-label': (p.productName || 'AgentLink') + (p.endorsed ? ' by 4thTech' : '') },
      h(Mark, { size: layout === 'stacked' ? s * 2 : s, mono: p.mono, title: '' }),
      h('span', { className: 'al-lockup-words' },
        h(Wordmark, { height: s * 0.82 }),
        p.endorsed ? h('span', { className: 'al-lockup-by al-text-caption' }, 'by 4thTech') : null));
  }

  function Icon(p) {
    var s = p.size || 16, inner = ICONS[p.name] || ICONS['circle'];
    return h('svg', { className: cx('al-icon', p.className), width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: p.strokeWidth || 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': p.label ? null : 'true', role: p.label ? 'img' : null, 'aria-label': p.label || null, dangerouslySetInnerHTML: { __html: inner } });
  }

  /* ---------- actions & forms ---------- */
  function Button(p) {
    var v = p.variant || 'secondary', s = p.size || 'md';
    var o = rest(p, ['variant', 'size', 'icon', 'iconRight', 'kbd', 'children', 'className', 'block']);
    o.type = o.type || 'button';
    o.className = cx('al-btn', 'al-btn-' + v, 'al-btn-' + s, p.block && 'al-btn-block', p.className);
    return h('button', o,
      p.icon ? h(Icon, { name: p.icon, size: s === 'lg' ? 18 : 16 }) : null,
      p.children != null ? h('span', null, p.children) : null,
      p.iconRight ? h(Icon, { name: p.iconRight, size: 16 }) : null,
      p.kbd ? h(Kbd, null, p.kbd) : null);
  }
  function Kbd(p) { return h('kbd', { className: 'al-kbd' }, p.children); }

  var fid = 0;
  function TextField(p) {
    var id = R.useMemo(function () { return p.id || 'al-f' + (++fid); }, []);
    var o = rest(p, ['label', 'hint', 'error', 'mono', 'prefix', 'className', 'id']);
    o.id = id; o.className = cx('al-input', p.mono && 'al-text-code'); o['aria-invalid'] = p.error ? 'true' : null;
    o['aria-describedby'] = (p.hint || p.error) ? id + '-d' : null;
    return h('div', { className: cx('al-field', p.error && 'is-error', p.className) },
      p.label ? h('label', { htmlFor: id, className: 'al-field-label al-text-body-sm' }, p.label) : null,
      h('div', { className: 'al-input-wrap' }, p.prefix ? h('span', { className: 'al-input-prefix al-text-code' }, p.prefix) : null, h('input', o)),
      (p.error || p.hint) ? h('div', { id: id + '-d', className: cx('al-field-hint al-text-caption', p.error && 'is-error') },
        p.error ? h(Icon, { name: 'circle-alert', size: 14 }) : null, p.error || p.hint) : null);
  }
  function Switch(p) {
    var st = R.useState(!!p.defaultChecked), on = p.checked != null ? p.checked : st[0];
    function t() { if (p.disabled) return; if (p.checked == null) st[1](!on); p.onChange && p.onChange(!on); }
    return h('label', { className: cx('al-switch-row', p.disabled && 'is-disabled') },
      h('span', { className: 'al-switch-text' }, h('span', { className: 'al-text-body' }, p.label), p.description ? h('span', { className: 'al-text-caption al-muted' }, p.description) : null),
      h('button', { type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', className: cx('al-switch', on && 'is-on'), onClick: t, disabled: p.disabled },
        h('span', { className: 'al-switch-knob' }), h('span', { className: 'al-switch-state al-text-label' }, on ? 'On' : 'Off')));
  }
  function Segmented(p) {
    var st = R.useState(p.defaultValue != null ? p.defaultValue : (p.options[0] || {}).value), val = p.value != null ? p.value : st[0];
    return h('div', { className: 'al-seg', role: 'radiogroup', 'aria-label': p.label },
      p.options.map(function (o) {
        var on = o.value === val;
        return h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', className: cx('al-seg-opt al-text-body-sm', on && 'is-on'),
          onClick: function () { if (p.value == null) st[1](o.value); p.onChange && p.onChange(o.value); } },
          on ? h(Icon, { name: 'check', size: 14 }) : null, o.label, o.hint ? h('span', { className: 'al-seg-hint' }, o.hint) : null);
      }));
  }

  /* ---------- status ---------- */
  var STATUS = {
    'sent': ['info', 'arrow-right', 'Sent'], 'received': ['neutral', 'inbox', 'Received'], 'delivered': ['success', 'receipt-delivered', 'Delivered'],
    'opened': ['success', 'receipt-opened', 'Opened'], 'accepted': ['success', 'receipt-accepted', 'Accepted'], 'rejected': ['neutral', 'receipt-rejected', 'Rejected'],
    'recording': ['info', 'refresh-cw', 'Recording'], 'recorded': ['proof', 'proof-seal', 'Recorded'], 'needs-approval': ['accent', 'approval', 'Needs approval'],
    'approved': ['success', 'check', 'Approved'], 'denied': ['neutral', 'x', 'Denied'], 'expired': ['neutral', 'clock', 'Expired'],
    'needs-setup': ['warning', 'settings', 'Needs setup'], 'needs-credits': ['warning', 'circle-alert', 'Needs credits'], 'failed': ['danger', 'triangle-alert', 'Failed'],
    'online': ['success', 'circle', 'Online'], 'last-seen': ['neutral', 'clock', 'Last seen'], 'paused': ['neutral', 'pause', 'Paused'], 'offline': ['neutral', 'wifi-off', 'Offline']
  };
  function StatusChip(p) {
    var s = STATUS[p.status] || STATUS['sent'];
    return h('span', { className: cx('al-chip', 'al-tone-' + s[0], p.className) },
      h(Icon, { name: s[1], size: 12, strokeWidth: 2.25 }), h('span', { className: 'al-text-label' }, p.children || s[2]), p.detail ? h('span', { className: 'al-chip-detail al-text-body-sm' }, p.detail) : null);
  }

  /* ---------- identity ---------- */
  var IDL = { selfdeclared: ['selfdeclared', 'identity-selfdeclared', 'Self-declared'], checked: ['checked', 'identity-checked', 'Safety code checked'],
    registered: ['registered', 'identity-registered', 'Registered'], verified: ['verified', 'identity-verified', 'Verified domain'], 'domain-warning': ['warning', 'domain-warning', 'Domain no longer verified'] };
  function IdentityLabel(p) {
    var k = IDL[p.kind] || IDL.selfdeclared, txt = k[2];
    if (p.kind === 'verified' && p.domain) txt += ' · ' + p.domain;
    return h('span', { className: cx('al-idl', 'al-idl-' + k[0], p.className), title: p.kind === 'selfdeclared' ? 'Name chosen by its owner. Compare the safety code to be sure.' : null },
      h(Icon, { name: k[1], size: 12, strokeWidth: 2.25 }), h('span', { className: 'al-text-body-sm' }, txt),
      p.punycode ? h('span', { className: 'al-idl-puny al-text-code' }, p.punycode) : null,
      p.date ? h('span', { className: 'al-idl-date al-text-body-sm' }, p.date) : null);
  }
  function Fingerprint(p) {
    return h('span', { className: cx('al-fp', p.className) }, p.prefix ? h('span', { className: 'al-text-body-sm al-muted' }, p.prefix) : null,
      h('code', { className: 'al-text-code', 'aria-label': (p.value || '').split('').join(' ') }, p.value));
  }
  function ContactName(p) {
    var n = formatContactName(p);
    return h('span', { className: cx('al-cname', 'al-cname-' + n.kind, p.className) },
      n.kind === 'fingerprint' ? h(Fingerprint, { prefix: 'Contact', value: p.fingerprint }) : h('span', { className: 'al-cname-text' }, n.text),
      p.label && n.kind !== 'alias' ? h(IdentityLabel, { kind: p.label, domain: p.domain }) : (p.label && p.showLabel ? h(IdentityLabel, { kind: p.label, domain: p.domain }) : null));
  }
  function SafetyCode(p) {
    var state = p.state || 'unchecked', groups = (p.code || '').split(' ');
    var who = p.contactName || 'your contact';
    return h('section', { className: cx('al-sc', 'is-' + state), 'aria-label': 'Safety code' },
      h('div', { className: 'al-sc-head' }, h(Icon, { name: 'safety-code', size: 16 }), h('span', { className: 'al-text-label' }, state === 'changed' ? 'Safety code changed' : 'Safety code')),
      h('div', { className: 'al-sc-code al-text-code-lg', role: 'text', 'aria-label': groups.map(function (g) { return g.split('').join(' '); }).join(', ') },
        groups.map(function (g, i) { return h('span', { key: i }, g); })),
      state === 'changed' ? h('p', { className: 'al-text-body' }, (p.contactName || 'This contact') + '’s agent updated its keys (same owner). The safety code changed. Compare it again.') : null,
      state === 'unchecked' || state === 'changed' ? h(F, null,
        h('p', { className: 'al-text-body al-muted' }, 'Compare with ' + who + ' by phone or in person. It should read the same on both screens.'),
        h('div', { className: 'al-sc-actions' }, h(Button, { variant: 'secondary', icon: 'check', onClick: p.onMatch }, 'They match'), h(Button, { variant: 'ghost', icon: 'x', onClick: p.onMismatch }, 'They don’t'))) : null,
      state === 'matched' ? h('p', { className: 'al-sc-ok al-text-body' }, h(Icon, { name: 'identity-checked', size: 16 }), 'Matched. ' + who + ' now shows as Safety code checked.') : null,
      state === 'mismatch' ? h('div', { className: 'al-sc-stop' }, h(Icon, { name: 'triangle-alert', size: 16 }),
        h('div', null, h('p', { className: 'al-text-body' }, h('strong', null, 'Pairing stopped. Nothing was shared.')),
          h('p', { className: 'al-text-body-sm al-muted' }, 'Codes that differ can mean the invite was copied or changed on the way. Ask ' + who + ' for a new invite through a channel you trust.'))) : null);
  }
  function Avatar(p) {
    var t = (p.text || '?').replace(/[“”"]/g, '').trim();
    var ini = t.indexOf('Contact ') === 0 ? '#' : t.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    return h('span', { className: 'al-avatar al-text-label', 'aria-hidden': 'true' }, ini);
  }
  function ContactCard(p) {
    var n = formatContactName(p);
    return h('div', { className: cx('al-contact', p.state && 'is-' + p.state) },
      h(Avatar, { text: n.text }),
      h('div', { className: 'al-contact-main' },
        h('div', { className: 'al-contact-name' }, h(ContactName, { alias: p.alias, name: p.name, fingerprint: p.fingerprint, label: p.label, domain: p.domain, showLabel: true })),
        h('div', { className: 'al-contact-meta al-text-body-sm al-muted' },
          p.agent ? h('span', null, h(Icon, { name: 'agent', size: 14 }), p.agent) : null,
          p.aiApp ? h('span', null, p.aiApp) : null,
          p.fingerprint ? h(Fingerprint, { value: p.fingerprint }) : null)),
      h('div', { className: 'al-contact-side' }, p.status ? h(StatusChip, { status: p.status, detail: p.statusDetail }) : null, p.actions || null));
  }

  /* ---------- trust ---------- */
  var URL_RE = /(https?:\/\/[^\s]+)/g;
  function inert(text) {
    return String(text).split(URL_RE).map(function (part, i) {
      if (i % 2 === 1) { var d = part.replace(/^https?:\/\//, '').split(/[\/?#]/)[0]; return h('span', { key: i, className: 'al-inert-link', title: 'Link not opened. Domain: ' + d }, h(Icon, { name: 'eye-off', size: 12 }), d); }
      return part;
    });
  }
  function UntrustedContent(p) {
    var lab = p.unknown ? ('Request from Contact ' + (p.fingerprint || '') + ': unknown sender, their words, not instructions') : ('From ' + p.from + ': their words, not instructions');
    var kind = p.kind ? p.kind.charAt(0).toUpperCase() + p.kind.slice(1) : null;
    return h('figure', { className: cx('al-untrusted', p.unknown && 'is-unknown', p.className), role: 'group', 'aria-label': lab },
      h('figcaption', { className: 'al-untrusted-label al-text-body-sm' }, h(Icon, { name: 'untrusted', size: 14 }), h('span', null, lab), kind ? h('span', { className: 'al-untrusted-kind al-text-label' }, kind) : null),
      h('div', { className: 'al-untrusted-body al-text-body' }, p.fileName ? h('code', { className: 'al-text-code' }, p.fileName) : inert(p.children)));
  }

  /* ---------- approvals ---------- */
  var ATYPE = { 'new-contact': ['user-plus', 'New contact'], proof: ['proof-seal', 'Add proof'], 'file-over-limit': ['file', 'File over limit'], 'document-key': ['key-round', 'Include document key'] };
  function ApprovalFooter() { return h('p', { className: 'al-approval-foot al-text-caption' }, h(Icon, { name: 'approval', size: 14 }), 'Your AI can’t approve this for you.'); }
  function ApprovalState(p) {
    var m = { waiting: ['info', 'approval', 'Waiting for ' + (p.method || 'your passkey') + '… Confirm in the system prompt.'], approved: ['success', 'check', 'Approved. Your AI will continue.'],
      denied: ['neutral', 'x', 'Denied. Nothing was sent.'], expired: ['neutral', 'clock', 'This request expired.'], failed: ['danger', 'triangle-alert', 'Approval didn’t go through. Nothing was sent.'],
      'decided-elsewhere': ['neutral', 'check', 'Already approved on your phone.'] }[p.state];
    if (!m) return null;
    return h('div', { className: cx('al-astate', 'al-tone-' + m[0]), role: 'status', 'aria-live': 'polite' }, h(Icon, { name: m[1], size: 16 }), h('span', { className: 'al-text-body' }, m[2]),
      p.state === 'expired' ? h(Button, { size: 'sm', variant: 'ghost' }, 'Ask again') : null);
  }
  function Row(label, value) { return h('div', { className: 'al-arow' }, h('dt', { className: 'al-text-label' }, label), h('dd', { className: 'al-text-body' }, value)); }
  function ApprovalCard(p) {
    var t = ATYPE[p.type] || ATYPE.proof, st = p.state || 'pending', open = st === 'pending';
    return h('article', { className: cx('al-card al-approval', 'is-' + st), 'aria-labelledby': 'al-ah' },
      h('header', { className: 'al-approval-top al-text-body-sm' },
        h('span', { className: 'al-approval-type' }, h(Icon, { name: t[0], size: 14 }), h('span', { className: 'al-text-label' }, t[1])),
        h('span', { className: 'al-muted' }, p.agent, p.time ? ' · ' + p.time : ''),
        p.expires ? h('span', { className: 'al-approval-exp al-muted' }, h(Icon, { name: 'clock', size: 12 }), p.expires) : null),
      h('h2', { id: 'al-ah', className: 'al-text-title-2', tabIndex: -1 }, p.headline),
      h('dl', { className: 'al-approval-rows' },
        p.who ? Row('Who', p.who) : null, p.what ? Row('What', p.what) : null, p.cost ? Row('Cost', p.cost) : null,
        p.why ? Row('Why', p.why) : null, p.consequence ? Row('Then', p.consequence) : null),
      p.children ? h('div', { className: 'al-approval-extra' }, p.children) : null,
      p.details ? h('details', { className: 'al-approval-details' }, h('summary', { className: 'al-text-body-sm' }, 'Details'), h('div', { className: 'al-text-code al-muted' }, p.details)) : null,
      open || st === 'waiting' ? h('div', { className: 'al-approval-actions' },
        h(Button, { variant: 'secondary', size: 'lg', onClick: p.onDeny, disabled: st === 'waiting' }, 'Deny'),
        h(Button, { variant: 'primary', size: 'lg', icon: 'approval', onClick: p.onApprove, disabled: st === 'waiting' }, 'Approve with ' + (p.method || 'passkey'))) : null,
      h(ApprovalState, { state: st, method: p.method }),
      h(ApprovalFooter));
  }
  function TermsDiff(p) {
    return h('table', { className: 'al-diff' },
      h('thead', null, h('tr', null, h('th', { className: 'al-text-label' }, ''), h('th', { className: 'al-text-label' }, p.oldLabel || 'v2'), h('th', { className: 'al-text-label' }, p.newLabel || 'v3'))),
      h('tbody', null, p.rows.map(function (r, i) {
        var ch = r.old !== r.new, kind = r.old == null ? 'added' : (r.new == null ? 'removed' : (ch ? 'changed' : 'same'));
        var sign = { added: '+', removed: '−', changed: '~', same: '' }[kind];
        return h('tr', { key: i, className: 'is-' + kind },
          h('th', { scope: 'row', className: 'al-text-body-sm al-muted' }, r.field, r.proposerWords ? h('span', { className: 'al-diff-theirs al-text-caption' }, 'their words') : null),
          h('td', { className: cx('al-text-body', ch && r.old != null && 'al-diff-old') }, r.old == null ? h('span', { className: 'al-muted' }, '—') : r.old),
          h('td', { className: cx('al-text-body', kind !== 'same' && 'al-diff-new') }, sign ? h('span', { className: 'al-diff-sign al-text-code', 'aria-label': kind }, sign) : null, r.new == null ? 'Removed' : r.new));
      })));
  }
  function CommitmentCard(p) {
    var st = p.state || 'pending', rej = p.mode === 'reject';
    return h('article', { className: cx('al-card al-commit', rej && 'is-reject', 'is-' + st) },
      h('header', { className: 'al-commit-head' },
        h(Icon, { name: rej ? 'receipt-rejected' : 'commitment', size: 18 }),
        h('div', null, h('div', { className: 'al-text-label' }, rej ? 'Rejecting terms' : 'Accepting terms'),
          h('h2', { className: 'al-text-title-2' }, p.headline)),
        p.validUntil ? h('span', { className: 'al-commit-valid al-text-body-sm' }, h(Icon, { name: 'clock', size: 12 }), 'Valid until ' + p.validUntil) : null),
      h('div', { className: 'al-commit-body' },
        h('div', { className: 'al-commit-who al-text-body-sm' }, h('span', { className: 'al-muted' }, 'With '), p.who),
        p.subject ? h(UntrustedContent, { from: p.proposer, kind: 'terms' }, p.subject) : null,
        p.diff ? h(TermsDiff, p.diff) : null,
        p.warning ? h(Banner, { tone: 'warning', compact: true }, p.warning) : null,
        h('dl', { className: 'al-approval-rows' },
          p.scope ? Row('This approval', p.scope) : null,
          p.consequence ? Row('Then', p.consequence) : null,
          Row('Cost', p.cost || 'Free for you'),
          p.autoNote ? Row('Rules', p.autoNote) : null),
        h('p', { className: 'al-commit-honest al-text-caption al-muted' }, 'AgentLink records the agreement. It doesn’t move money.'),
        p.fingerprint ? h('details', { className: 'al-approval-details' }, h('summary', { className: 'al-text-body-sm' }, 'Advanced'), h('div', { className: 'al-text-code al-muted' }, 'Terms fingerprint ' + p.fingerprint)) : null),
      st === 'pending' || st === 'waiting' ? h('div', { className: 'al-approval-actions' },
        h(Button, { variant: 'secondary', size: 'lg', onClick: p.onCancel, disabled: st === 'waiting' }, 'Cancel'),
        h(Button, { variant: rej ? 'danger' : 'primary', size: 'lg', icon: 'approval', onClick: p.onApprove, disabled: st === 'waiting' }, (rej ? 'Reject with ' : 'Accept with ') + (p.method || 'passkey'))) : null,
      h(ApprovalState, { state: st, method: p.method }),
      h(ApprovalFooter));
  }

  /* ---------- proof ---------- */
  function ProofBadge(p) {
    var st = p.state || 'recorded';
    var m = { recording: ['refresh-cw', 'Recording proof…'], recorded: ['proof-seal', 'Proof recorded'], failed: ['triangle-alert', 'Proof wasn’t recorded'], waiting: ['approval', 'Proof waiting for approval'] }[st];
    return h('span', { className: cx('al-proof', 'is-' + st), role: st === 'recording' ? 'status' : null },
      h(Icon, { name: m[0], size: 14 }), h('span', { className: 'al-text-body-sm' }, m[1]), p.time ? h('span', { className: 'al-proof-time al-text-code' }, p.time) : null);
  }
  function ReceiptTimeline(p) {
    var ICON = { recorded: 'proof-seal', delivered: 'receipt-delivered', opened: 'receipt-opened', accepted: 'receipt-accepted', rejected: 'receipt-rejected', received: 'inbox', sent: 'arrow-right' };
    return h('ol', { className: 'al-rt' }, p.steps.map(function (s, i) {
      return h('li', { key: i, className: cx('al-rt-step', s.done ? 'is-done' : 'is-pending', 'is-' + s.key, s.free && 'is-free') },
        h('span', { className: 'al-rt-dot' }, h(Icon, { name: ICON[s.key] || 'circle', size: 14 })),
        h('span', { className: 'al-rt-label al-text-body' }, s.label || (s.key.charAt(0).toUpperCase() + s.key.slice(1))),
        h('span', { className: 'al-rt-time al-text-code' }, s.done ? s.time : 'Waiting'));
    }));
  }

  /* ---------- credits ---------- */
  function CostChip(p) {
    return h('span', { className: cx('al-cost', p.free && 'is-free'), title: p.split || null },
      h('span', { className: 'al-text-code' }, p.free ? 'Free' : p.amount), p.source ? h('span', { className: 'al-text-body-sm al-muted' }, p.source) : null);
  }
  function CreditsMeter(p) {
    var pct = Math.min(100, Math.round((p.spentToday / p.budget) * 100));
    var low = p.state === 'low' || p.state === 'empty';
    return h('section', { className: cx('al-credits', p.state && 'is-' + p.state), 'aria-label': 'Credits' },
      h('div', { className: 'al-credits-top' },
        h('div', null, h('div', { className: 'al-text-label al-muted' }, p.test ? 'Test credits' : 'Credits'), h('div', { className: 'al-credits-bal al-text-title-1' }, p.balance)),
        h('div', { className: 'al-text-body-sm al-muted' }, p.proofsLeft + ' proofs left')),
      h('div', { className: 'al-credits-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': p.budget, 'aria-valuenow': p.spentToday, 'aria-label': 'Spent today' },
        h('span', { style: { width: pct + '%' } })),
      h('div', { className: 'al-credits-foot al-text-body-sm' }, h('span', { className: 'al-text-code' }, '$' + p.spentToday.toFixed(2) + ' of $' + p.budget + ' today'),
        h(Button, { size: 'sm', variant: low ? 'primary' : 'secondary', icon: 'plus' }, 'Add credits')),
      p.state === 'empty' ? h('p', { className: 'al-text-caption al-muted' }, 'Messages and files stay free.') : null);
  }

  /* ---------- files ---------- */
  function sanitize(n) { return String(n).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').slice(0, 80); }
  function FileCard(p) {
    var bad = p.integrity === 'failed';
    return h('div', { className: cx('al-file', bad && 'is-failed') },
      h('span', { className: 'al-file-ic' }, h(Icon, { name: bad ? 'triangle-alert' : 'file', size: 18 })),
      h('div', { className: 'al-file-main' },
        h('code', { className: 'al-file-name al-text-code' }, sanitize(p.name)),
        h('div', { className: 'al-file-meta al-text-body-sm al-muted' }, h('span', null, p.size), p.expiry ? h('span', null, p.expiry) : null, p.from ? h('span', null, p.from) : null),
        bad ? h('div', { className: 'al-file-bad al-text-body-sm' }, 'Failed its integrity check; not saved.') : null),
      h('div', { className: 'al-file-side' }, p.proof ? h(ProofBadge, { state: p.proof, time: p.proofTime }) : null, p.status ? h(StatusChip, { status: p.status }) : null, p.action || null));
  }

  /* ---------- developer ---------- */
  function CopyPrompt(p) {
    var st = R.useState(false);
    function copy() { try { navigator.clipboard && navigator.clipboard.writeText(p.prompt || p.command || ''); } catch (e) {} st[1](true); setTimeout(function () { st[1](false); }, 1600); }
    var isCmd = !!p.command && !p.prompt;
    return h('section', { className: cx('al-copy', p.size === 'hero' && 'is-hero') },
      h('header', { className: 'al-copy-head' },
        h('span', { className: 'al-copy-title' }, h(Icon, { name: isCmd ? 'terminal' : 'agent', size: 14 }), h('span', { className: 'al-text-label' }, p.title || (isCmd ? 'Terminal' : 'Paste this to your agent'))),
        h(Button, { size: 'sm', variant: p.size === 'hero' ? 'primary' : 'ghost', icon: st[0] ? 'check' : 'copy', onClick: copy, 'aria-live': 'polite' }, st[0] ? 'Copied' : 'Copy')),
      h('pre', { className: 'al-copy-body al-text-code' }, isCmd ? h(F, null, h('span', { className: 'al-copy-ps', 'aria-hidden': 'true' }, '$ '), h('span', { className: 'al-copy-cmd' }, p.command)) : p.prompt),
      p.note ? h('p', { className: 'al-copy-note al-text-caption al-muted' }, p.note) : null);
  }
  function SecretDisplay(p) {
    var st = R.useState(false), saved = st[0];
    var groups = String(p.value || '').split(' ');
    return h('section', { className: 'al-secret', 'aria-label': p.label },
      h('div', { className: 'al-secret-head' }, h('span', { className: 'al-text-label' }, p.label || 'Recovery code'), h('span', { className: 'al-text-caption al-muted' }, 'Shown once')),
      h('div', { className: 'al-secret-val al-text-code-lg' }, groups.map(function (g, i) { return h('span', { key: i }, g); })),
      p.explain ? h('p', { className: 'al-text-body-sm al-muted' }, p.explain) : null,
      h('div', { className: 'al-secret-actions' }, h(Button, { size: 'sm', icon: 'copy' }, 'Copy'), h(Button, { size: 'sm', icon: 'download' }, 'Download'), h(Button, { size: 'sm', icon: 'printer' }, 'Print')),
      h('label', { className: 'al-check al-text-body' }, h('input', { type: 'checkbox', checked: saved, onChange: function () { st[1](!saved); } }), 'I’ve saved it'),
      h(Button, { variant: 'primary', disabled: !saved, block: true }, 'Continue'));
  }

  /* ---------- feedback ---------- */
  var TONE_IC = { info: 'info', success: 'check', warning: 'triangle-alert', danger: 'circle-alert', neutral: 'info', offline: 'wifi-off', proof: 'proof-seal' };
  function Banner(p) {
    var tone = p.tone || 'info';
    return h('div', { className: cx('al-banner', 'al-tone-' + (tone === 'offline' ? 'neutral' : tone), p.compact && 'is-compact'), role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status' },
      h(Icon, { name: p.icon || TONE_IC[tone], size: 16 }),
      h('div', { className: 'al-banner-text al-text-body' }, p.title ? h('strong', null, p.title + ' ') : null, p.children),
      p.action ? h('div', { className: 'al-banner-act' }, p.action) : null);
  }
  function Toast(p) {
    var tone = p.tone || 'success';
    return h('div', { className: cx('al-toast', 'al-tone-' + tone), role: 'status', 'aria-live': 'polite' },
      h(Icon, { name: p.icon || TONE_IC[tone], size: 16 }), h('span', { className: 'al-text-body' }, p.children),
      p.action ? h('button', { type: 'button', className: 'al-toast-act al-text-body-sm' }, p.action) : null,
      h('button', { type: 'button', className: 'al-toast-x', 'aria-label': 'Dismiss' }, h(Icon, { name: 'x', size: 14 })));
  }
  function EmptyState(p) {
    return h('div', { className: 'al-empty' },
      h('span', { className: 'al-empty-ic' }, h(Icon, { name: p.icon || 'inbox', size: 20 })),
      h('p', { className: 'al-text-body' }, p.title),
      p.prompt ? h('code', { className: 'al-empty-try al-text-code' }, h('span', { className: 'al-muted' }, 'Try: '), p.prompt) : null,
      p.action || null);
  }

  /* ---------- shell ---------- */
  function Chrome(p) {
    var os = p.os || 'macos';
    var dots = h('span', { className: 'al-win-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    var ctrls = h('span', { className: 'al-win-ctrls', 'aria-hidden': 'true' }, os === 'windows' ? [h(Icon, { key: 1, name: 'minus', size: 14 }), h('span', { key: 2, className: 'al-win-max' }), h(Icon, { key: 3, name: 'x', size: 14 })] : h(Icon, { name: 'x', size: 14 }));
    return h('div', { className: cx('al-win-bar', 'is-' + os) }, os === 'macos' ? dots : null,
      h('span', { className: 'al-win-title al-text-body-sm' }, p.title || 'AgentLink'), os !== 'macos' ? ctrls : null);
  }
  function AppShell(p) {
    var nav = p.nav || [];
    return h('div', { className: cx('al-shell', p.className), style: p.height ? { height: p.height } : null },
      p.os ? h(Chrome, { os: p.os, title: p.title }) : null,
      h('div', { className: 'al-shell-main' },
        h('nav', { className: 'al-side', 'aria-label': 'Main' },
          h('div', { className: 'al-side-brand' }, h(Lockup, { size: 18 })),
          p.agent ? h('button', { type: 'button', className: 'al-agent-switch' }, h(Icon, { name: 'agent', size: 14 }), h('span', { className: 'al-text-body-sm' }, p.agent), h(Icon, { name: 'chevron-down', size: 14 })) : null,
          h('ul', null, nav.map(function (n, i) {
            return h('li', { key: i }, h('a', { href: '#', className: cx('al-nav', n.active && 'is-active'), 'aria-current': n.active ? 'page' : null },
              h(Icon, { name: n.icon, size: 16 }), h('span', { className: 'al-text-body' }, n.label), n.count ? h('span', { className: 'al-nav-count al-text-code' }, n.count) : null));
          }))),
        h('main', { className: 'al-shell-content' }, p.children)),
      h('footer', { className: 'al-statusbar al-text-code' },
        h('span', { className: 'al-sb-item' }, h('span', { className: cx('al-dot', 'is-' + (p.connection || 'connected')) }), { connected: 'Connected', offline: 'Offline · showing what’s saved here', paused: 'Paused' }[p.connection || 'connected']),
        p.statusItems ? p.statusItems.map(function (s, i) { return h('span', { key: i, className: 'al-sb-item' }, s); }) : null,
        h('span', { className: 'al-sb-spacer' }), p.version ? h('span', { className: 'al-sb-item' }, p.version) : null));
  }
  function TrayMenu(p) {
    var item = function (ic, label, extra, k) { return h('li', { key: k, role: 'menuitem', tabIndex: -1, className: 'al-tray-item al-text-body' }, h(Icon, { name: ic, size: 14 }), h('span', null, label), extra || null); };
    var st = p.status || 'connected';
    return h('div', { className: 'al-tray', role: 'menu', 'aria-label': 'AgentLink' },
      h('div', { className: 'al-tray-status al-text-body-sm' }, h('span', { className: cx('al-dot', 'is-' + st) }), { connected: 'Connected', paused: 'Paused', offline: 'Offline' }[st]),
      h('ul', null,
        p.approvals ? item('approval', 'Approvals waiting', h('span', { className: 'al-nav-count al-text-code' }, p.approvals), 'a') : null,
        item('activity', 'Open dashboard', p.os === 'macos' ? h(Kbd, null, '⌘D') : null, 'b'),
        item(st === 'paused' ? 'play' : 'pause', st === 'paused' ? 'Resume' : 'Pause', null, 'c'),
        p.updateReady ? item('download', 'Update ready · restart', h('span', { className: 'al-text-code al-muted' }, p.updateReady), 'd') : null),
      h('div', { className: 'al-tray-sep' }),
      h('ul', null, item('x', 'Quit AgentLink', p.os === 'macos' ? h(Kbd, null, '⌘Q') : null, 'q')));
  }

  window.AgentLink = { Mark: Mark, Wordmark: Wordmark, Lockup: Lockup, Icon: Icon, Button: Button, Kbd: Kbd, TextField: TextField, Switch: Switch, Segmented: Segmented,
    StatusChip: StatusChip, IdentityLabel: IdentityLabel, Fingerprint: Fingerprint, ContactName: ContactName, SafetyCode: SafetyCode, ContactCard: ContactCard,
    UntrustedContent: UntrustedContent, ApprovalCard: ApprovalCard, TermsDiff: TermsDiff, CommitmentCard: CommitmentCard, ProofBadge: ProofBadge, ReceiptTimeline: ReceiptTimeline,
    CostChip: CostChip, CreditsMeter: CreditsMeter, FileCard: FileCard, CopyPrompt: CopyPrompt, SecretDisplay: SecretDisplay, Banner: Banner, Toast: Toast, EmptyState: EmptyState,
    AppShell: AppShell, TrayMenu: TrayMenu, formatContactName: formatContactName, iconNames: Object.keys(ICONS) };
})();
