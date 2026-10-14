// ESLint plugin `boundaries`: the import forms and member accesses that `no-restricted-imports`
// cannot see. It uses the same decision function as the static zones (policy.mjs violationFor).
//
//   dynamic import('x'), require('x'), `import x = require('x')`, `import('x').T` types
//       -> same restrictions as a static import; a non-literal specifier is reported because it
//          cannot be checked.
//   relative specifiers
//       -> in every import form, a path that resolves outside the package directory is reported
//          (a cross-package relative import would skip the layering rules).
//   `.subtle` member access and destructuring
//       -> `crypto.subtle` outside packages/crypto (backlog M0-10); catches aliases such as
//          `const c = globalThis.crypto; c.subtle`.

import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBTLE_ZONES, violationFor } from './policy.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The string a node spells, or null when it is not a plain string (Literal or bare template). */
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

const rule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { zone: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden: '{{message}}',
      escapes:
        'Relative import "{{specifier}}" leaves {{zone}}; import another package by its name.',
      nonLiteral:
        'Dynamic import or require with a non-literal specifier cannot be checked against the boundaries; use a string literal.',
      subtle:
        'crypto.subtle may be used only in packages/crypto; everything else uses @agentlink/crypto (AGENTS.md).',
    },
  },
  create(context) {
    const zone = context.options[0]?.zone ?? null;
    const zoneDir = zone === null ? null : resolve(ROOT, zone);

    function checkSpecifier(node, specifier) {
      if (specifier.startsWith('.')) {
        if (zoneDir === null) return;
        const target = resolve(dirname(context.filename), specifier);
        const rel = relative(zoneDir, target);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          context.report({ node, messageId: 'escapes', data: { specifier, zone } });
        }
        return;
      }
      const message = violationFor(zone, specifier);
      if (message !== null) context.report({ node, messageId: 'forbidden', data: { message } });
    }

    // Static imports are already covered by no-restricted-imports; here only the relative-path check.
    const checkStatic = (node) => {
      const specifier = staticString(node.source);
      if (specifier?.startsWith('.')) checkSpecifier(node, specifier);
    };

    // Forms that no-restricted-imports does not cover: full check, non-literal specifiers reported.
    const checkDynamic = (node, specifierNode) => {
      const specifier = staticString(specifierNode);
      if (specifier === null) {
        context.report({ node, messageId: 'nonLiteral' });
        return;
      }
      checkSpecifier(node, specifier);
    };

    return {
      ImportDeclaration: checkStatic,
      ExportNamedDeclaration: checkStatic,
      ExportAllDeclaration: checkStatic,
      ImportExpression: (node) => checkDynamic(node, node.source),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          checkDynamic(node, node.arguments[0]);
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          checkDynamic(node, node.moduleReference.expression);
        }
      },
      TSImportType(node) {
        // `source` since typescript-eslint 8.x; older versions wrapped the literal in `argument`.
        checkDynamic(node, node.source ?? node.argument?.literal);
      },
      MemberExpression(node) {
        if (SUBTLE_ZONES.includes(zone)) return;
        const key = node.property;
        const named = !node.computed && key.type === 'Identifier' && key.name === 'subtle';
        const indexed = node.computed && staticString(key) === 'subtle';
        if (named || indexed) context.report({ node, messageId: 'subtle' });
      },
      Property(node) {
        // const { subtle } = crypto;   const { subtle: s } = globalThis.crypto;
        if (SUBTLE_ZONES.includes(zone) || node.parent?.type !== 'ObjectPattern') return;
        const named =
          !node.computed && node.key.type === 'Identifier' && node.key.name === 'subtle';
        if (named || (node.computed && staticString(node.key) === 'subtle')) {
          context.report({ node, messageId: 'subtle' });
        }
      },
    };
  },
};

export default { rules: { 'no-bypass': rule } };
