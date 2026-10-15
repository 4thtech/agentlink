// M1-13a: the LLM run's transcript readers (llm/harness.ts), on fixed event lines, so a change in
// how a step is judged is caught without an API key. The event shapes follow Claude Code's
// `--output-format stream-json` and `codex exec --json`.
import { describe, expect, it } from 'vitest';
import { parseClaude, parseCodex } from '../llm/harness.js';

const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n');

describe('transcript readers', () => {
  it('Claude Code: pairs tool_use with tool_result, strips the MCP prefix, reads cost and denials', () => {
    const parsed = parseClaude(
      lines(
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'mcp__agentlink__agentlink_status', input: {} },
              { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/h/.agentlink/x' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: 'Permission denied',
                is_error: true,
              },
            ],
          },
        },
        'not json',
        {
          type: 'result',
          result: 'Nothing new.',
          total_cost_usd: 0.0123,
          num_turns: 2,
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
        },
      ),
    );
    expect(parsed.calls).toEqual([
      { name: 'agentlink_status', input: {}, result: 'ok', isError: false },
      {
        name: 'Read',
        input: { file_path: '/h/.agentlink/x' },
        result: 'Permission denied',
        isError: true,
      },
    ]);
    expect(parsed).toMatchObject({
      finalText: 'Nothing new.',
      costUsd: 0.0123,
      turns: 2,
      inputTokens: 15,
      outputTokens: 7,
    });
  });

  it('Claude Code: a tool_use without a result counts as an error', () => {
    const parsed = parseClaude(
      lines({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
      }),
    );
    expect(parsed.calls[0]?.isError).toBe(true);
  });

  it('Codex: reads MCP tool calls, shell commands, the last message and summed usage', () => {
    const parsed = parseCodex(
      lines(
        { type: 'thread.started' },
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'agentlink',
            tool: 'agentlink_inbox',
            arguments: {},
            result: { content: [{ type: 'text', text: 'two messages' }] },
            error: null,
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            tool: 'agentlink_send',
            arguments: { to: 'Bob' },
            result: null,
            error: { message: 'user cancelled MCP tool call' },
            status: 'failed',
          },
        },
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
        { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
      ),
    );
    expect(parsed.calls.map((c) => [c.name, c.isError])).toEqual([
      ['agentlink_inbox', false],
      ['agentlink_send', true],
    ]);
    expect(parsed.calls[0]?.result).toContain('two messages');
    expect(parsed).toMatchObject({
      finalText: 'Done.',
      inputTokens: 150,
      outputTokens: 25,
      turns: 2,
    });
  });
});
