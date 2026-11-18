// TRAY-POPOVER (D-155): the popover's one preload (bundled as dist-release/main/widget-preload.cjs;
// kept .js here, deps-check allows no .cjs in apps/). Sandboxed, context-isolated: it exposes exactly
// `window.agentlinkWidget.{open({route, target?}), quit(), close()}` on one invoke channel.
// - Only on a fresh user activation (a real click or key press; a script can't make one).
// - One call at a time. Only the fixed shapes are sent: `route` from the fixed list, `target` a short
//   string the main process checks again (widget-ipc.ts); any other field is dropped.
// - Never rejects, answers only true or false.
// It can open a page in the main window, close the popover or quit: what the tray already does.
'use strict';
/* global require */

// A sandboxed preload is a CommonJS script: `require('electron')` is its only way in.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'agentlink:widget';
const ROUTES = ['home', 'inbox', 'files', 'approvals', 'updates'];
const MAX_TARGET_CHARS = 64;
let busy = false;

function activated() {
  try {
    const activation = globalThis.navigator && globalThis.navigator.userActivation;
    return Boolean(activation && activation.isActive === true);
  } catch {
    return false;
  }
}

function send(message) {
  if (busy || !activated()) return Promise.resolve(false);
  busy = true;
  return ipcRenderer
    .invoke(CHANNEL, message)
    .then(
      (answer) => answer === true,
      () => false,
    )
    .finally(() => {
      busy = false;
    });
}

function open(request) {
  if (request === null || typeof request !== 'object') return Promise.resolve(false);
  const route = request.route;
  if (typeof route !== 'string' || !ROUTES.includes(route)) return Promise.resolve(false);
  const target = request.target;
  if (target === undefined) return send({ action: 'open', route });
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_CHARS) {
    return Promise.resolve(false);
  }
  return send({ action: 'open', route, target });
}

function quit() {
  return send({ action: 'quit' });
}

function close() {
  return send({ action: 'close' });
}

contextBridge.exposeInMainWorld('agentlinkWidget', Object.freeze({ open, quit, close }));
