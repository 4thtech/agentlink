// A reader for the small YAML subset docs/status.yaml uses, so the repository needs no YAML
// dependency (a new dependency needs a justification, and a status file does not warrant one).
//
// Supported: block maps, block lists (`- scalar`, or `- key: value` followed by more keys), flow
// lists of scalars (`[a, "b, c"]`), plain and double-quoted scalars (escapes \" \\ \n \t),
// full-line comments, trailing ` #` comments after plain scalars, and blank lines. Indentation is
// spaces. Every scalar is read as a string; lists become arrays and maps become objects. The
// schema check in status.mjs types the fields.
// Anything else (anchors, tags, single quotes, multi-line scalars, flow maps, tabs, duplicate
// keys) throws, so a mistake in the status file fails the check instead of being read wrongly.

function fail(lineNo, message) {
  throw new Error(`status.yaml line ${lineNo}: ${message}`);
}

function unquote(text, lineNo) {
  // `text` starts with a double quote.
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      const map = { '"': '"', '\\': '\\', n: '\n', t: '\t' };
      if (!(next in map)) fail(lineNo, `unsupported escape \\${next ?? ''}`);
      out += map[next];
      i += 1;
    } else if (ch === '"') {
      const rest = text.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) fail(lineNo, 'text after a closing quote');
      return out;
    } else {
      out += ch;
    }
  }
  return fail(lineNo, 'unterminated double-quoted string');
}

function scalar(text, lineNo) {
  const t = text.trim();
  if (t.startsWith('"')) return unquote(t, lineNo);
  if (/^['&*!|>{]/.test(t)) fail(lineNo, `unsupported YAML syntax starting with ${t[0]}`);
  // A trailing ` #` comment: found with indexOf, not a regex (a regex backtracks on long runs).
  const hash = t.indexOf(' #');
  return hash === -1 ? t : t.slice(0, hash).trimEnd();
}

function flowList(text, lineNo) {
  const t = text.trim();
  if (!t.endsWith(']')) fail(lineNo, 'a flow list must close on the same line');
  const body = t.slice(1, -1);
  const items = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted && ch === '\\') {
      cur += ch + (body[i + 1] ?? '');
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    } else if (ch === ',' && !quoted) {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (quoted) fail(lineNo, 'unterminated string in a flow list');
  if (cur.trim() !== '') items.push(cur);
  return items.map((item) => scalar(item, lineNo));
}

function value(text, lineNo) {
  return text.trim().startsWith('[') ? flowList(text, lineNo) : scalar(text, lineNo);
}

/** Splits `key: rest` (the key is a bare word); null when the text is not a map entry. */
function splitEntry(text) {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|$)/.exec(text);
  return m ? { key: m[1], rest: m[2] ?? '' } : null;
}

const isItem = (text) => text === '-' || text.startsWith('- ');

export function parseYaml(source) {
  const lines = [];
  source.split('\n').forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.includes('\t')) fail(lineNo, 'tabs are not allowed');
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), lineNo });
  });

  let pos = 0;

  function parseBlock(indent) {
    return isItem(lines[pos].text) ? parseList(indent) : parseMap(indent);
  }

  // `first` is the already-consumed first entry of a map that starts on a list item's line.
  function parseMap(indent, first) {
    const out = {};
    let pending = first;
    while (pending || pos < lines.length) {
      const line = pending ?? lines[pos];
      if (!pending) {
        if (line.indent < indent) break;
        if (line.indent > indent) fail(line.lineNo, 'unexpected indentation');
        pos += 1;
      }
      pending = undefined;
      const entry = splitEntry(line.text);
      if (!entry) fail(line.lineNo, `expected "key: value", got "${line.text}"`);
      if (['__proto__', 'constructor', 'prototype'].includes(entry.key)) {
        fail(line.lineNo, `the key "${entry.key}" is not allowed`);
      }
      if (Object.hasOwn(out, entry.key)) fail(line.lineNo, `duplicate key "${entry.key}"`);
      if (entry.rest === '' || entry.rest.startsWith('#')) {
        const next = lines[pos];
        out[entry.key] = next && next.indent > indent ? parseBlock(next.indent) : '';
      } else {
        out[entry.key] = value(entry.rest, line.lineNo);
      }
    }
    return out;
  }

  function parseList(indent) {
    const out = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line.lineNo, 'unexpected indentation');
      if (!isItem(line.text)) break;
      const rest = line.text.slice(1).trim();
      pos += 1;
      if (rest === '') {
        const next = lines[pos];
        if (!next || next.indent <= indent) fail(line.lineNo, 'empty list item');
        out.push(parseBlock(next.indent));
      } else if (splitEntry(rest)) {
        // `- key: value`: the map's other keys sit in the column after "- ".
        const childIndent = indent + (line.text.length - rest.length);
        out.push(parseMap(childIndent, { indent: childIndent, text: rest, lineNo: line.lineNo }));
      } else {
        out.push(value(rest, line.lineNo));
      }
    }
    return out;
  }

  if (lines.length === 0) return {};
  const result = parseBlock(lines[0].indent);
  if (pos < lines.length) fail(lines[pos].lineNo, 'unexpected content');
  return result;
}
