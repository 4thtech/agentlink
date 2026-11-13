// @vitest-environment jsdom
// ATT-APP-ATTACH (08 §1 "Attach a file"; 11 §5; I-4, I-5): the owner attaches light text files in a
// conversation and sends them to that person with an optional note.
//
// - Attach (a file picker for .md, .markdown, .txt and .json) and drag-and-drop onto the
//   conversation add files as chips; each chip can be removed; nothing leaves before Send.
// - The page refuses another type, a file over 8 MB and a sixth file before sending anything.
// - Send posts once to `POST /api/ui/attach`: the CSRF header, an octet-stream body holding
//   `{to, text, files: [{name, data}]}` (base64). The browser signs nothing.
// - A refusal says what to do; `no_folder` shows Home's Send folder banner.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACH_PATH, createAttachApi } from './attach-api.js';
import { AttachComposer } from './attach-composer.js';
import { Conversation } from './conversation.js';
import type { SendFolderApi } from './send-folder-banner.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTACT = `0x${'1a'.repeat(20)}`;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function server(answer: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const folderApi = (none: boolean): SendFolderApi => ({
  noFolder: () => Promise.resolve(none),
  prepare: () => Promise.resolve(undefined),
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const file = (name: string, text: string | Uint8Array<ArrayBuffer>, type = 'text/markdown'): File =>
  new File([text], name, { type });

function pick(files: File[]): void {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function drop(target: Element, files: File[]): void {
  const over = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: { files, types: ['Files'] } });
  const dropped = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropped, 'dataTransfer', { value: { files, types: ['Files'] } });
  act(() => {
    target.dispatchEvent(over);
    target.dispatchEvent(dropped);
  });
}

const chips = (): string[] =>
  [...host.querySelectorAll('[data-attach-chip]')].map((c) => c.textContent ?? '');
const button = (name: RegExp): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  expect(found, String(name)).toBeDefined();
  return found as HTMLButtonElement;
};

function render(
  api = createAttachApi({ fetch: server({ status: 200, body: {} }).fetch, token: 't' }),
  onSent = () => undefined,
  none = false,
) {
  act(() => {
    root.render(
      h(AttachComposer, {
        contactId: CONTACT,
        name: 'Marko',
        api,
        folderApi: folderApi(none),
        onSent,
      }),
    );
  });
}

describe('AttachComposer', () => {
  it('Attach adds chips (name and size), Remove takes one out, nothing is sent', async () => {
    const s = server({ status: 200, body: { status: 'sent' } });
    render(createAttachApi({ fetch: s.fetch, token: 'tok' }));
    expect(button(/^Attach/).disabled).toBe(false);
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.md,.markdown,.txt,.json');
    expect(input.multiple).toBe(true);
    pick([file('plan.md', '# Plan\n'), file('notes.txt', 'hello', 'text/plain')]);
    await settle();
    expect(chips()).toHaveLength(2);
    expect(chips()[0]).toContain('plan.md');
    expect(chips()[1]).toContain('notes.txt');
    act(() => button(/^Remove plan\.md$/).click());
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toContain('notes.txt');
    expect(s.calls).toHaveLength(0);
  });

  it('Send is off until a file is attached', () => {
    render();
    expect(button(/^Send$/).disabled).toBe(true);
  });

  it('refuses another type, a file over 8 MB and a sixth file, before sending anything', async () => {
    const s = server({ status: 200, body: { status: 'sent' } });
    render(createAttachApi({ fetch: s.fetch, token: 'tok' }));
    pick([file('run.exe', 'x', 'application/octet-stream')]);
    await settle();
    expect(chips()).toHaveLength(0);
    expect(host.textContent).toContain('Only Markdown, text and JSON files');
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.md');
    pick([big]);
    await settle();
    expect(chips()).toHaveLength(0);
    expect(host.textContent).toContain('over 8 MB');
    pick(Array.from({ length: 6 }, (_, i) => file(`f${String(i)}.md`, 'x')));
    await settle();
    expect(chips()).toHaveLength(5);
    expect(host.textContent).toContain('Up to 5 files');
    expect(s.calls).toHaveLength(0);
  });

  it('Send posts the files and the note to the attach route, then clears and reports', async () => {
    const s = server({ status: 200, body: { status: 'sent' } });
    let sent = 0;
    render(createAttachApi({ fetch: s.fetch, token: 'tok' }), () => {
      sent += 1;
    });
    pick([file('plan.md', '# Plan šđ\n')]);
    await settle();
    const note = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      set?.call(note, 'Here is the plan');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button(/^Send$/).click());
    await settle();
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0] as Call;
    expect(call.url).toBe(ATTACH_PATH);
    expect(call.method).toBe('POST');
    expect(call.headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(call.headers.get('content-type')).toBe('application/octet-stream');
    expect(call.headers.get('X-AgentLink-Input')).toBeNull();
    const text = new TextDecoder().decode(call.body as Uint8Array);
    const parsed = JSON.parse(text) as {
      to: string;
      text: string;
      files: { name: string; data: string }[];
    };
    expect(parsed.to).toBe(CONTACT);
    expect(parsed.text).toBe('Here is the plan');
    expect(parsed.files.map((f) => f.name)).toEqual(['plan.md']);
    expect(
      new TextDecoder().decode(
        Uint8Array.from(atob(parsed.files[0]?.data ?? ''), (c) => c.charCodeAt(0)),
      ),
    ).toBe('# Plan šđ\n');
    expect(chips()).toHaveLength(0);
    expect(sent).toBe(1);
    expect(host.textContent).toContain('Sent to Marko');
  });

  it('no Send folder: shows the Send folder banner and keeps the files', async () => {
    const s = server({ status: 409, body: { error: 'no_folder' } });
    render(createAttachApi({ fetch: s.fetch, token: 'tok' }), () => undefined, true);
    pick([file('plan.md', 'x')]);
    await settle();
    act(() => button(/^Send$/).click());
    await settle();
    expect(host.querySelector('[data-send-folder-banner]')).not.toBeNull();
    expect(chips()).toHaveLength(1);
  });

  it('a server refusal says what to do in plain words', async () => {
    for (const [error, words] of [
      ['type', 'Only Markdown, text and JSON files'],
      ['not_text', "isn't plain text"],
      ['not_ready', "Marko isn't connected yet"],
      ['policy', "Your rules don't allow"],
    ] as const) {
      const s = server({ status: 400, body: { error } });
      render(createAttachApi({ fetch: s.fetch, token: 'tok' }));
      pick([file('plan.md', 'x')]);
      await settle();
      act(() => button(/^Send$/).click());
      await settle();
      expect(host.textContent, error).toContain(words);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('uses no word 11 §5 keeps out of the default UI', async () => {
    render();
    pick([file('plan.md', 'x')]);
    await settle();
    expect(host.textContent ?? '').not.toMatch(/wallet|gas|seed phrase|transaction|upload/i);
  });
});

describe('ATT-APP-ATTACH journey: drop a file on the conversation and send it', () => {
  it('drop → chip → Send → the thread is read again', async () => {
    const s = server({ status: 200, body: { status: 'sent' } });
    let refreshed = 0;
    const thread = {
      state: 'ready' as const,
      inbox: { items: [], paged: false },
      sent: { items: [], paged: false },
    };
    act(() => {
      root.render(
        h(Conversation, {
          name: 'Marko',
          agent: 'Bo',
          pro: false,
          thread,
          loadEarlier: () => Promise.resolve(),
          attach: {
            contactId: CONTACT,
            api: createAttachApi({ fetch: s.fetch, token: 'tok' }),
            folderApi: folderApi(false),
            onSent: () => {
              refreshed += 1;
            },
          },
        }),
      );
    });
    const zone = host.querySelector('[data-attach-zone]');
    expect(zone).not.toBeNull();
    drop(zone as Element, [file('brief.md', '# Brief\n')]);
    await settle();
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toContain('brief.md');
    act(() => button(/^Send$/).click());
    await settle();
    expect(s.calls).toHaveLength(1);
    expect(refreshed).toBe(1);
    expect(chips()).toHaveLength(0);
  });

  it('a removed connection has no composer', () => {
    act(() => {
      root.render(
        h(Conversation, {
          name: 'Marko',
          agent: 'Bo',
          pro: false,
          removed: true,
          thread: {
            state: 'ready' as const,
            inbox: { items: [], paged: false },
            sent: { items: [], paged: false },
          },
          loadEarlier: () => Promise.resolve(),
          attach: {
            contactId: CONTACT,
            api: createAttachApi({ fetch: server({ status: 200, body: {} }).fetch, token: 't' }),
            folderApi: folderApi(false),
            onSent: () => undefined,
          },
        }),
      );
    });
    expect(host.querySelector('[data-attach-zone]')).toBeNull();
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });
});
