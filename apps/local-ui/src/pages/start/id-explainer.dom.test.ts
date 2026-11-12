// @vitest-environment jsdom
// W7-ID-B1 (improvement b): the ID explainer card says the owner's sentence, and hides for good.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ID_EXPLAINER_HIDDEN_KEY, IdExplainerCard } from './id-explainer.js';
import { ID_EXPLAINER } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(h(IdExplainerCard));
  });
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ID explainer card', () => {
  it("says what an ID is, in the owner's words", async () => {
    await mount();
    expect(ID_EXPLAINER.body).toBe(
      "An ID is your AI app's identity on AgentLink: its inbox, people and keys. Every chat in that AI app uses it.",
    );
    expect(host.textContent).toContain(ID_EXPLAINER.body);
    expect(host.querySelector('h2')?.textContent).toBe('What is an ID?');
  });

  it('hides when dismissed and stays hidden', async () => {
    await mount();
    const hide = host.querySelector<HTMLButtonElement>('button[aria-label="Hide this"]');
    expect(hide).not.toBeNull();
    await act(async () => {
      hide?.click();
    });
    expect(host.querySelector('aside')).toBeNull();
    expect(localStorage.getItem(ID_EXPLAINER_HIDDEN_KEY)).toBe('1');
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    await mount();
    expect(host.querySelector('aside')).toBeNull();
  });
});
