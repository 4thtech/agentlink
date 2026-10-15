// The diff, the JSON editor and the TOML writer (M1-9a): exact, additive changes, and refusal of
// anything that cannot be changed that way.
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './diff.js';
import { HarnessError } from './errors.js';
import { addJsonMcpServer } from './json-config.js';
import { addTomlMcpServer, agentlinkTable, scanToml } from './toml-config.js';

const ENTRY = { command: 'npx', args: ['-y', '@4thtech/agentlink', 'mcp'] };
const TABLE = agentlinkTable('npx', ['-y', '@4thtech/agentlink', 'mcp']);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HarnessError ? error.code : 'other';
  }
  return undefined;
}

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a\n', 'a\n', 'f')).toEqual([]);
  });

  it('shows only the added lines, with no context', () => {
    expect(unifiedDiff('one\ntwo\nthree\n', 'one\nnew\ntwo\nthree\n', 'f')).toEqual([
      '--- a/f',
      '+++ b/f',
      '@@ -1,0 +2,1 @@',
      '+new',
    ]);
  });

  it('shows a whole new file as additions', () => {
    expect(unifiedDiff('', 'x\ny\n', 'f')).toEqual([
      '--- a/f',
      '+++ b/f',
      '@@ -0,0 +1,2 @@',
      '+x',
      '+y',
    ]);
  });

  it('shows changed lines as a removal and an addition', () => {
    expect(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f')).toEqual([
      '--- a/f',
      '+++ b/f',
      '@@ -2,1 +2,1 @@',
      '-b',
      '+B',
    ]);
  });
});

describe('addJsonMcpServer', () => {
  it('creates a new file with the entry alone', () => {
    const edit = addJsonMcpServer(undefined, ENTRY);
    expect(edit.status).toBe('change');
    expect(edit.status === 'change' && JSON.parse(edit.text)).toEqual({
      mcpServers: { agentlink: ENTRY },
    });
  });

  it('adds mcpServers as the first key and changes no existing line', () => {
    const before = `${JSON.stringify({ theme: 'dark', n: 1 }, null, 2)}\n`;
    const edit = addJsonMcpServer(before, ENTRY);
    if (edit.status !== 'change') throw new Error('expected a change');
    const removed = unifiedDiff(before, edit.text, 'f').filter(
      (l) => l.startsWith('-') && !l.startsWith('---'),
    );
    expect(removed).toEqual([]);
    expect(JSON.parse(edit.text)).toEqual({
      mcpServers: { agentlink: ENTRY },
      theme: 'dark',
      n: 1,
    });
  });

  it('keeps the other servers and adds the entry before them without touching their lines', () => {
    const before = `${JSON.stringify({ mcpServers: { other: { command: 'x', env: { K: 'v' } } } }, null, 2)}\n`;
    const edit = addJsonMcpServer(before, ENTRY);
    if (edit.status !== 'change') throw new Error('expected a change');
    const diff = unifiedDiff(before, edit.text, 'f');
    expect(diff.filter((l) => l.startsWith('-') && !l.startsWith('---'))).toEqual([]);
    expect(diff.join('\n')).not.toContain('"K"');
    expect(JSON.parse(edit.text).mcpServers.other).toEqual({ command: 'x', env: { K: 'v' } });
  });

  it('keeps a 4-space indent and a missing final newline', () => {
    const before = JSON.stringify({ a: 1 }, null, 4);
    const edit = addJsonMcpServer(before, ENTRY);
    if (edit.status !== 'change') throw new Error('expected a change');
    expect(edit.text.endsWith('\n')).toBe(false);
    expect(edit.text).toContain('\n    "mcpServers"');
  });

  it('reports an identical entry as present and a different one as a conflict, never changing it', () => {
    const same = `${JSON.stringify({ mcpServers: { agentlink: ENTRY } }, null, 2)}\n`;
    expect(addJsonMcpServer(same, ENTRY).status).toBe('present');
    const other = `${JSON.stringify({ mcpServers: { agentlink: { command: 'old' } } }, null, 2)}\n`;
    expect(addJsonMcpServer(other, ENTRY).status).toBe('conflict');
  });

  it('refuses malformed JSON, a non-object file and an odd mcpServers', () => {
    expect(code(() => addJsonMcpServer('{ "a": ', ENTRY))).toBe('malformed');
    expect(code(() => addJsonMcpServer('[]', ENTRY))).toBe('malformed');
    expect(code(() => addJsonMcpServer('', ENTRY))).toBe('malformed');
    expect(code(() => addJsonMcpServer(JSON.stringify({ mcpServers: [] }, null, 2), ENTRY))).toBe(
      'unsupported_format',
    );
  });

  it('refuses a file it could not rewrite exactly (comments are not JSON; odd layout is not kept)', () => {
    expect(code(() => addJsonMcpServer('// hi\n{}\n', ENTRY))).toBe('malformed');
    expect(code(() => addJsonMcpServer('{"a":1}', ENTRY))).toBe('unsupported_format');
    expect(code(() => addJsonMcpServer('{\r\n  "a": 1\r\n}\r\n', ENTRY))).toBe(
      'unsupported_format',
    );
  });
});

describe('scanToml', () => {
  it('collects tables and key paths, including strings that span lines', () => {
    const { paths } = scanToml(
      [
        '# comment',
        'model = "gpt"',
        'notes = """',
        '[not.a.table]',
        '"""',
        'list = [',
        '  "a", # c',
        '  "b",',
        ']',
        '',
        '[mcp_servers.other]',
        'command = "x"',
        '[[arr."dotted.key"]]',
        "lit = 'a # b'",
      ].join('\n'),
    );
    expect(paths.map((p) => `${p.kind}:${p.path.join('/')}`)).toEqual([
      'key:model',
      'key:notes',
      'key:list',
      'table:mcp_servers/other',
      'key:mcp_servers/other/command',
      'table:arr/dotted.key',
      'key:arr/dotted.key/lit',
    ]);
  });

  it.each([
    ['an unterminated string', 'a = "oops\n'],
    ['an unterminated multi-line string', 'a = """oops\n'],
    ['an unclosed array', 'a = [1,\n'],
    ['a line that is not a statement', 'just words\n'],
    ['a header that does not close', '[table\n'],
    ['an empty value', 'a =\n'],
    ['text after a header', '[t] x\n'],
    ['a stray closing bracket', 'a = 1]\n'],
  ])('refuses %s', (_label, text) => {
    expect(code(() => scanToml(text))).toBe('malformed');
  });
});

describe('addTomlMcpServer', () => {
  it('creates the file with the table alone', () => {
    const edit = addTomlMcpServer(undefined, TABLE);
    expect(edit).toEqual({
      status: 'change',
      text: '[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech/agentlink", "mcp"]\n',
    });
  });

  it('appends after the existing content with a blank line, changing no existing line', () => {
    const before = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const edit = addTomlMcpServer(before, TABLE);
    if (edit.status !== 'change') throw new Error('expected a change');
    expect(edit.text.startsWith(before)).toBe(true);
    expect(edit.text).toBe(
      `${before}\n[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech/agentlink", "mcp"]\n`,
    );
  });

  it('adds a newline when the file does not end with one, and keeps CRLF', () => {
    const edit = addTomlMcpServer('a = 1', TABLE);
    expect(
      edit.status === 'change' && edit.text.startsWith('a = 1\n\n[mcp_servers.agentlink]'),
    ).toBe(true);
    const crlf = addTomlMcpServer('a = 1\r\n', TABLE);
    expect(crlf.status === 'change' && crlf.text).toBe(
      'a = 1\r\n\r\n[mcp_servers.agentlink]\r\ncommand = "npx"\r\nargs = ["-y", "@4thtech/agentlink", "mcp"]\r\n',
    );
  });

  it('treats the exact table as present, and an entry in any other form as a conflict', () => {
    expect(addTomlMcpServer(`a = 1\n\n${TABLE.join('\n')}\n`, TABLE)).toEqual({
      status: 'present',
    });
    for (const text of [
      '[mcp_servers.agentlink]\ncommand = "old"\n',
      '[mcp_servers]\nagentlink = { command = "old" }\n',
      'mcp_servers.agentlink.command = "old"\n',
      '[mcp_servers."agentlink".env]\nA = "b"\n',
    ]) {
      expect(addTomlMcpServer(text, TABLE)).toEqual({ status: 'conflict' });
    }
  });

  it('refuses a file that assigns mcp_servers whole, and malformed TOML', () => {
    expect(code(() => addTomlMcpServer('mcp_servers = { a = { command = "x" } }\n', TABLE))).toBe(
      'unsupported_format',
    );
    expect(code(() => addTomlMcpServer('model = "oops\n', TABLE))).toBe('malformed');
  });

  it('puts a quoted agent name argument in the table as a TOML string', () => {
    const table = agentlinkTable('npx', ['-y', '@4thtech/agentlink', 'mcp', '--agent', 'work-1']);
    expect(table[2]).toBe('args = ["-y", "@4thtech/agentlink", "mcp", "--agent", "work-1"]');
  });

  // IR-M1-9a-1 F02: a key written with quoting or escapes is the same key.
  it.each([
    '[mcp_servers."agentlink"]\ncommand = "old"\n',
    '[mcp_servers."agent\\u006cink"]\ncommand = "old"\n',
    '[mcp_servers.\'agentlink\']\ncommand = "old"\n',
    '[mcp_servers]\n"agent\\x6cink" = { command = "old" }\n',
  ])('never writes a duplicate table next to an agentlink key written another way (%#)', (text) => {
    const edit = (() => {
      try {
        return addTomlMcpServer(text, TABLE);
      } catch (error) {
        return error instanceof HarnessError ? error.code : 'other';
      }
    })();
    expect(edit).not.toMatchObject({ status: 'change' });
  });
});
