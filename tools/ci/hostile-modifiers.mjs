// REL-0514 CI-E2E-MODIFIER: the e2e.yml "hostile suites ran in full" check. It refuses a test
// modifier (it.skip, test.only, describe.each, ...) anywhere in code, also mid-line
// (`foo(); it.only(...)`), and counts plain it( / test( calls the same way. Comments, strings and
// template literals are blanked first, so text such as "it. " or 'test.skip' in them is never a hit.

// Replaces comments, strings and template literal text with spaces (newlines kept). Template
// `${...}` parts are blanked too: a call inside one is not a test declaration.
export function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += blank(src.slice(i, j));
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (c === '`' && ch === '$' && src[j + 1] === '{') depth++;
        else if (c === '`' && ch === '}' && depth > 0) depth--;
        else if (ch === c && depth === 0) break;
        else if (ch === '\n' && c !== '`') break;
        j++;
      }
      j = Math.min(j + 1, n);
      out += blank(src.slice(i, j));
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const MODIFIER = /(?<![\w$.])(?:it|test|describe)\s*\.\s*[A-Za-z]+/;
const CALL = /(?<![\w$.])(?:it|test)\s*\(/g;

// { modifier: boolean, count: number } for one test file's source.
export function scanTestSource(src) {
  const code = stripNonCode(src);
  return { modifier: MODIFIER.test(code), count: (code.match(CALL) || []).length };
}
