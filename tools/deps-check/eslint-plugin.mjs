// ESLint plugin `boundaries`: the import forms and member accesses that `no-restricted-imports`
// cannot see. It uses the same decision function as the static zones (policy.mjs violationFor).
//
//   dynamic import('x'), require('x'), `import x = require('x')`, `import('x').T` types
//       -> same restrictions as a static import; a non-literal specifier is reported because it
//          cannot be checked.
//   other ways to reach the module loader
//       -> `require` used as anything but a direct call, `module.require`, `process.mainModule`,
//          `process.getBuiltinModule`, `process.binding`, `_linkedBinding`, `dlopen`, and
//          `node:module` (createRequire) outside the files policy.mjs lists.
//   non-canonical workspace specifiers (IR-M1-1g-b-1 L-1, L-2)
//       -> in every import form, static included: upper case, or an empty, `.` or `..` segment.
//   relative specifiers
//       -> in every import form, a path that resolves outside the package directory is reported
//          (a cross-package relative import would skip the layering rules).
//   `.subtle` member access and destructuring
//       -> `crypto.subtle` outside packages/crypto (backlog M0-10); catches aliases such as
//          `const c = globalThis.crypto; c.subtle`, `Reflect.get(crypto, 'subtle')` and computed
//          access on a `crypto` receiver.
//
// eval, new Function and string timers are handled by the core rules no-eval, no-new-func and
// no-implied-eval, which eslint.config.mjs turns on for packages/** and apps/**.

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOADER_MEMBERS,
  SUBTLE_ZONES,
  isNonCanonicalWorkspaceSpecifier,
  testSeamViolation,
  violationFor,
} from './policy.mjs';

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

/** True when `node` (an Identifier) names something rather than reading a variable. */
function isDeclarationOrKey(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'MemberExpression') return parent.property === node && !parent.computed;
  if (parent.type === 'Property') return parent.key === node && !parent.computed;
  if (parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') {
    return parent.key === node && !parent.computed;
  }
  if (parent.id === node) return true; // function, variable, type alias, class declarations
  if (Array.isArray(parent.params) && parent.params.includes(node)) return true;
  return /^(Import|Export)(Default)?Specifier$/.test(parent.type);
}

/** `crypto` or `<something>.crypto`: the receiver whose members are the Web Crypto API. */
function isCryptoReceiver(node) {
  if (node.type === 'Identifier') return node.name === 'crypto';
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'crypto'
  );
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
      loader:
        '"{{name}}" reaches the module loader around the import checks; import the module with a static or literal import.',
      commonjs: '"module" (CommonJS) is not allowed; the packages are ESM.',
      require:
        '"require" may only be called directly with a string literal; other uses bypass the import checks.',
      subtle:
        'crypto.subtle may be used only in packages/crypto; everything else uses @4thtech-io/crypto (AGENTS.md).',
    },
  },
  create(context) {
    const zone = context.options[0]?.zone ?? null;
    const zoneDir = zone === null ? null : resolve(ROOT, zone);
    const file = relative(ROOT, context.filename).split(sep).join('/');
    const subtleAllowed = SUBTLE_ZONES.includes(zone);

    function checkSpecifier(node, specifier) {
      if (specifier.startsWith('.')) {
        if (zoneDir === null) return;
        const target = resolve(dirname(context.filename), specifier);
        const rel = relative(zoneDir, target);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          context.report({ node, messageId: 'escapes', data: { specifier, zone } });
        }
        const seam = testSeamViolation(file, relative(ROOT, target).split(sep).join('/'));
        if (seam !== null)
          context.report({ node, messageId: 'forbidden', data: { message: seam } });
        return;
      }
      const message = violationFor(zone, specifier, file);
      if (message !== null) context.report({ node, messageId: 'forbidden', data: { message } });
    }

    // Static imports are covered by no-restricted-imports; here the relative-path check,
    // node:module (a file-specific allowlist that no-restricted-imports cannot express) and
    // non-canonical workspace specifiers (`.`, `..` or empty segments, upper case), which its
    // gitignore-style patterns do not normalise (IR-M1-1g-b-1 L-1, L-2).
    const checkStatic = (node) => {
      const specifier = staticString(node.source);
      if (specifier === null) return;
      if (
        specifier.startsWith('.') ||
        /^(node:)?module$/.test(specifier) ||
        isNonCanonicalWorkspaceSpecifier(specifier)
      ) {
        checkSpecifier(node, specifier);
      }
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

    const checkLoaderName = (node, name) => {
      if (LOADER_MEMBERS.includes(name))
        context.report({ node, messageId: 'loader', data: { name } });
    };
    const reportSubtle = (node) => context.report({ node, messageId: 'subtle' });

    return {
      ImportDeclaration: checkStatic,
      ExportNamedDeclaration: checkStatic,
      ExportAllDeclaration: checkStatic,
      ImportExpression: (node) => checkDynamic(node, node.source),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          checkDynamic(node, node.arguments[0]);
        }
        // Reflect.get(crypto, 'subtle'), Object.getOwnPropertyDescriptor(crypto, 'subtle')
        const callee = node.callee;
        if (
          !subtleAllowed &&
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          ['Reflect', 'Object'].includes(callee.object.name) &&
          node.arguments.some((argument) => staticString(argument) === 'subtle')
        ) {
          reportSubtle(node);
        }
      },
      Identifier(node) {
        // `module` as a value (module.exports, module.constructor._load, const m = module): CommonJS.
        if (node.name === 'module' && !isDeclarationOrKey(node)) {
          context.report({ node, messageId: 'commonjs' });
          return;
        }
        // `require` anywhere but as the callee of a direct call (const r = require; require.call(...)).
        if (node.name !== 'require' || isDeclarationOrKey(node)) return;
        const parent = node.parent;
        if (parent?.type === 'CallExpression' && parent.callee === node) return;
        context.report({ node, messageId: 'require' });
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
        const key = node.property;
        const name = node.computed
          ? staticString(key)
          : key.type === 'Identifier'
            ? key.name
            : null;
        if (name !== null) {
          checkLoaderName(node, name);
          if (
            name === 'require' &&
            node.object.type === 'Identifier' &&
            node.object.name === 'module'
          ) {
            context.report({ node, messageId: 'loader', data: { name: 'module.require' } });
          }
          if (
            name === 'binding' &&
            node.object.type === 'Identifier' &&
            node.object.name === 'process'
          ) {
            context.report({ node, messageId: 'loader', data: { name: 'process.binding' } });
          }
        }
        if (subtleAllowed) return;
        if (name === 'subtle') reportSubtle(node);
        // crypto[k] with a computed, non-literal key could be 'subtle'.
        if (node.computed && name === null && isCryptoReceiver(node.object)) reportSubtle(node);
      },
      Property(node) {
        // const { subtle } = crypto;   const { subtle: s } = globalThis.crypto;
        if (node.parent?.type !== 'ObjectPattern') return;
        const name = node.computed
          ? staticString(node.key)
          : node.key.type === 'Identifier'
            ? node.key.name
            : staticString(node.key);
        if (name !== null) checkLoaderName(node, name);
        if (!subtleAllowed && name === 'subtle') reportSubtle(node);
      },
    };
  },
};

export default { rules: { 'no-bypass': rule } };
