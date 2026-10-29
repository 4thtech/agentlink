// HOTFIX-045-PASTE-FIELD: the multi-line field is a labelled well that grows with its box.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import css from './components.css?raw';
import { TextArea } from './index.js';

describe('TextArea', () => {
  it('renders label, a multi-line well and the hint, linked for assistive tech', () => {
    const html = renderToStaticMarkup(
      h(TextArea, { id: 'p', label: 'Invite', hint: 'Paste it here', rows: 4 }),
    );
    expect(html).toContain('<label for="p"');
    expect(html).toContain('al-input-wrap al-input-wrap-multi');
    expect(html).toContain('<textarea');
    expect(html).toContain('rows="4"');
    expect(html).toContain('aria-describedby="p-d"');
    expect(html).toContain('id="p-d"');
  });

  it('shows an error instead of the hint and marks the box invalid', () => {
    const html = renderToStaticMarkup(
      h(TextArea, { id: 'p', hint: 'Paste it', error: 'Not a link' }),
    );
    expect(html).toContain('Not a link');
    expect(html).not.toContain('Paste it');
    expect(html).toContain('aria-invalid="true"');
  });

  it('its inset rule outranks the one-line .al-input rule', () => {
    expect(css).toContain('.al-input.al-textarea {');
  });
});
