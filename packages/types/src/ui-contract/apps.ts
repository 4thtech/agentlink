// The local app's AI apps wire contract (U3-i; 08 §1, 04 §2.5.1, b11 §30): the requests the page
// sends and the answers the server gives, as typed samples. It is shared test data, not runtime
// logic. Both sides test against it, so neither can drift alone:
//
// - packages/node (src/local-ui/ui-contract-apps.test.ts) runs the REAL route handlers of U3-f
//   (api/apps.ts) on the sample world and asserts the real answer is the sample answer;
// - apps/local-ui (src/pages/apps/contract.test.ts) asserts its client builds exactly each sample
//   request and reads each sample answer as the outcome word next to it.
//
// apps/local-ui may not import packages/node (package layering, tools/deps-check); both may import
// this subpath of @4thtech-io/types. Names, paths and ids here are filler, never a real person's.

export const APPS_PATH = '/api/ui/apps';
export const APPS_PREVIEW_PATH = '/api/ui/apps/preview';
export const APPS_APPLY_PATH = '/api/ui/apps/apply';
export const APPS_DISCONNECT_PATH = '/api/ui/apps/disconnect';
/** The presence routes read an octet-stream body (the proof); the input travels in a header. */
export const APPS_OCTET_STREAM = 'application/octet-stream';

export interface AppsUiAnswer<B = unknown> {
  readonly status: number;
  readonly body: B;
}

/** One AgentLink entry (the only part of an AI app's file the page ever receives). */
export interface AppsEntry {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, never>>;
}

/** The word for what the server read from an app's own file. */
export type AppsStateWord = 'not_connected' | 'connected' | 'not_ours' | 'unreadable';

export interface AppsListApp {
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly state: AppsStateWord;
  readonly agent?: string;
  readonly quitFirst: boolean;
}
export interface AppsListBody {
  readonly desktopRunning: boolean;
  readonly apps: readonly AppsListApp[];
}

export type AppsChangeKind = 'connect' | 'move' | 'disconnect';
export interface AppsPreviewChange {
  readonly status: 'change';
  readonly kind: AppsChangeKind;
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly folder: string;
  readonly oldEntry: AppsEntry | null;
  readonly newEntry: AppsEntry | null;
  readonly oldAgent: string | null;
  readonly newAgent: string | null;
  readonly changeId: string;
}
export interface AppsPreviewNoChange {
  readonly status:
    'present' | 'not_connected' | 'conflict' | 'quit_first' | 'unreadable' | 'not_found';
  readonly app: string;
  readonly name: string;
}

const entry = (folder: string): AppsEntry => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', folder],
  env: {},
});

/**
 * The world the node test builds: the open agent is `personal` (agentId `APPS_WORLD.agentId`);
 * Claude Code runs it, Codex runs `work`, Cursor runs nothing, Claude Desktop runs nothing and is
 * open (so it must be quit first), Windsurf has an entry AgentLink did not write.
 */
export const APPS_WORLD = {
  agentId: '0x71c4000000000000000000000000000000009a2e',
  openAgent: 'personal',
  files: {
    'claude-code': '/Users/me/.claude.json',
    codex: '/Users/me/.codex/config.toml',
    cursor: '/Users/me/.cursor/mcp.json',
    'claude-desktop': '/Users/me/Library/Application Support/Claude/claude_desktop_config.json',
    windsurf: '/Users/me/.codeium/windsurf/mcp_config.json',
  },
} as const;

/** `GET /api/ui/apps` in APPS_WORLD. */
export const APPS_LIST = {
  answer: {
    status: 200,
    body: {
      desktopRunning: true,
      apps: [
        {
          app: 'claude-code',
          name: 'Claude Code',
          path: '~/.claude.json',
          state: 'connected',
          agent: 'personal',
          quitFirst: false,
        },
        {
          app: 'codex',
          name: 'Codex',
          path: '~/.codex/config.toml',
          state: 'connected',
          agent: 'work',
          quitFirst: false,
        },
        {
          app: 'cursor',
          name: 'Cursor',
          path: '~/.cursor/mcp.json',
          state: 'not_connected',
          quitFirst: false,
        },
        {
          app: 'claude-desktop',
          name: 'Claude Desktop',
          path: '~/Library/Application Support/Claude/claude_desktop_config.json',
          state: 'not_connected',
          quitFirst: true,
        },
        {
          app: 'windsurf',
          name: 'Windsurf',
          path: '~/.codeium/windsurf/mcp_config.json',
          state: 'not_ours',
          quitFirst: false,
        },
      ],
    },
  } satisfies AppsUiAnswer<AppsListBody>,
} as const;

/** `GET /api/ui/apps/preview?app=&agent=`: the three kinds, and the non-change words. */
export const APPS_PREVIEW = {
  connect: {
    query: { app: 'cursor', agent: 'personal' },
    answer: {
      status: 200,
      body: {
        status: 'change',
        kind: 'connect',
        app: 'cursor',
        name: 'Cursor',
        path: '~/.cursor/mcp.json',
        folder: 'personal',
        oldEntry: null,
        newEntry: entry('personal'),
        oldAgent: null,
        newAgent: 'personal',
        changeId: '4e96e29cf581fb90eae5033626403707ff6023add92781110abac990c362c977',
      },
    } satisfies AppsUiAnswer<AppsPreviewChange>,
  },
  move: {
    query: { app: 'codex', agent: 'personal' },
    answer: {
      status: 200,
      body: {
        status: 'change',
        kind: 'move',
        app: 'codex',
        name: 'Codex',
        path: '~/.codex/config.toml',
        folder: 'personal',
        oldEntry: entry('work'),
        newEntry: entry('personal'),
        oldAgent: 'work',
        newAgent: 'personal',
        changeId: '1074a908b352e336d420290a7c54054c4fc6d2c2362f5c49067fd8c9b78412e3',
      },
    } satisfies AppsUiAnswer<AppsPreviewChange>,
  },
  disconnect: {
    query: { app: 'claude-code', agent: 'personal' },
    answer: {
      status: 200,
      body: {
        status: 'change',
        kind: 'disconnect',
        app: 'claude-code',
        name: 'Claude Code',
        path: '~/.claude.json',
        folder: 'personal',
        oldEntry: entry('personal'),
        newEntry: null,
        oldAgent: 'personal',
        newAgent: null,
        changeId: '84cd6aba4cd5348a36cb2c0672e52804d3858f97a2a316d831b926b4b8f2123e',
      },
    } satisfies AppsUiAnswer<AppsPreviewChange>,
  },
  quitFirst: {
    query: { app: 'claude-desktop', agent: 'personal' },
    answer: {
      status: 200,
      body: { status: 'quit_first', app: 'claude-desktop', name: 'Claude Desktop' },
    } satisfies AppsUiAnswer<AppsPreviewNoChange>,
  },
  conflict: {
    query: { app: 'windsurf', agent: 'personal' },
    answer: {
      status: 200,
      body: { status: 'conflict', app: 'windsurf', name: 'Windsurf' },
    } satisfies AppsUiAnswer<AppsPreviewNoChange>,
  },
} as const;

/** `POST apply` and `POST disconnect`: the input is exactly `{changeId}`. */
export const APPS_CHANGE = {
  applyInput: { changeId: APPS_PREVIEW.connect.answer.body.changeId },
  disconnectInput: { changeId: APPS_PREVIEW.disconnect.answer.body.changeId },
  /** The statement the owner signs, as the server words it (04 §2.5.1). */
  statements: {
    connect: 'Connect Cursor to Personal',
    move: 'Codex will use Personal instead of work',
    disconnect: 'Claude Code will stop using Personal',
  },
  done: {
    answer: { status: 200, body: { status: 'done', app: 'cursor' } } satisfies AppsUiAnswer,
    outcome: 'done',
  },
  /**
   * The refusals as the real routes answer them: `{error}` words (the page maps each to a calm
   * sentence). `outcome` is the page's word for it.
   */
  refusals: [
    { answer: { status: 409, body: { error: 'changed' } }, outcome: 'changed' },
    { answer: { status: 409, body: { error: 'quit_first' } }, outcome: 'quit_first' },
    { answer: { status: 409, body: { error: 'agent_changed' } }, outcome: 'agent_changed' },
    { answer: { status: 409, body: { error: 'agent_mismatch' } }, outcome: 'agent_changed' },
    { answer: { status: 409, body: { error: 'write_failed' } }, outcome: 'write_failed' },
    { answer: { status: 409, body: { error: 'not_applied' } }, outcome: 'not_applied' },
  ] satisfies readonly { answer: AppsUiAnswer; outcome: string }[],
} as const;
