// BROWSER-UPDATE (I-4): updating AgentLink is never reachable from an AI app. No MCP tool updates or
// restarts, and the MCP server's own page has no update desk (its Settings › Updates answers 501);
// only the owner's `agentlink ui` host (session cookie, CSRF, Origin, mark gate) wires one.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOL_NAMES } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';

const src = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('BROWSER-UPDATE is never an MCP path (I-4)', () => {
  it('no MCP tool updates, installs or restarts', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/update|upgrade|install|restart|relaunch/);
    }
  });

  it('the MCP server never wires the updater or an update desk', async () => {
    const mcp = await readFile(join(src, 'mcp', 'command.ts'), 'utf8');
    expect(mcp).not.toMatch(/browser-update|npm-update-check|appUpdate|BrowserUpdater|relaunch/);
  });

  it('only the terminal `ui` host wires it', async () => {
    const ui = await readFile(join(src, 'commands', 'ui.ts'), 'utf8');
    expect(ui).toMatch(/BrowserUpdater|nodeBrowserUpdater/);
  });
});
