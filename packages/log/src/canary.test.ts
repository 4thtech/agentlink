// Secret-canary test for @agentlink/log itself (04 §8.4, M0-8). Runs in `pnpm test`, so ci-gate
// fails when a canary reaches any log line at any level. Later packages add their own
// `*.canary.test.ts` with their canaries (see README.md).

import { describe, expect, it } from 'vitest';
import { LEVELS } from './logger.js';
import { SENSITIVE_KEYS } from './redact.js';
import {
  assertNoCanaryLeaks,
  KEY_ONLY_CANARY,
  PATTERN_CANARIES,
  type CanaryRun,
  type Canary,
} from './testing.js';

const byName = (name: string): string => {
  const canary = PATTERN_CANARIES.find((entry) => entry.name === name);
  if (canary === undefined) throw new Error(`no canary ${name}`);
  return canary.value;
};

/** Each pattern canary embedded the way it shows up in real output. */
function shapes(): string[] {
  return [
    byName('hex64'),
    byName('hex64-0x'),
    byName('nsec'),
    byName('ncryptsec'),
    `/bucket/object?X-Amz-Signature=${byName('sigv4-signature')}`,
    `/bucket/object?X-Amz-Credential=${byName('sigv4-credential')}&X-Amz-Date=20261014T000000Z`,
    `AWS4-HMAC-SHA256 Credential=CANARY/20261014/auto/s3/aws4_request, SignedHeaders=host, ${byName('aws4-authorization')}`,
    `Authorization: ${byName('authorization-header')}`,
    `relay refused Bearer ${byName('bearer')}`,
    `/approve?t=${byName('local-ui-token')}`,
    `recovery code ${byName('recovery-code')}`,
    'recovery code CANARYRECOVERYCODE234567',
    byName('jwt'),
    `https://storage.example/bucket/object?sig=${byName('url-query')}`,
    `https://agentlink.example/drop/abc#${byName('url-fragment')}`,
    `https://user:${byName('url-userinfo')}@relay.example/`,
    `data:text/plain;base64,${byName('data-uri')}`,
    `https://rpc.example/v2/${byName('url-path')}`,
    `next=https%3A%2F%2Fdrop.example%2Fo%2F${byName('url-encoded')}&x=1`,
    `next=%2Fo%3FX-Amz-Security-Token%3D${byName('sigv4-encoded')}%26X-Amz-Date%3D1`,
    `["authorization-scheme","Basic ${byName('basic')}"]`,
    `request failed: password=${byName('key-value')}`,
  ];
}

/** Drives every public path of the logger with every canary, at every level. */
function exercise({ logger }: CanaryRun): void {
  const child = logger.child({ context: shapes(), token: KEY_ONLY_CANARY.value });
  for (const level of LEVELS) {
    for (const shape of shapes()) {
      // In the message, in a plain field, nested, in arrays, Maps and Sets, as an object key.
      logger[level](`event ${shape}`, {
        detail: shape,
        nested: { deeper: { list: [shape, { inner: shape }] } },
        map: new Map([
          ['k', shape],
          [shape, 'as key'],
        ]),
        set: new Set([shape]),
        [shape]: 'as key',
      });
      // In errors: message, stack, cause chain, AggregateError, own properties and their keys.
      const cause = new Error(`cause ${shape}`);
      const error = Object.assign(new Error(`failed ${shape}`, { cause }), {
        detail: shape,
        [shape]: 'as key',
      });
      logger[level]('error path', error);
      logger[level]('aggregate', { err: new AggregateError([error], `many ${shape}`) });
      child[level]('child', { shape });
      // Non-object fields: a thrown string, an array, a number-like (F01 of IR-M0-8-1).
      try {
        throw `thrown ${shape}`;
      } catch (thrown) {
        logger[level]('caught', thrown as Error);
      }
      logger[level]('array fields', [shape] as unknown as Error);
      // A URL-named field keeps only the origin.
      logger[level]('url field', { relayUrl: `wss://relay.example/${shape}`, url: shape });
    }
    // The shapeless canary under every sensitive key name, in several spellings.
    for (const key of SENSITIVE_KEYS) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      logger[level]('keyed', {
        [key]: KEY_ONLY_CANARY.value,
        [snake.toUpperCase()]: KEY_ONLY_CANARY.value,
        [`agent${key[0]!.toUpperCase()}${key.slice(1)}`]: KEY_ONLY_CANARY.value,
        wrapper: { [key]: { deep: KEY_ONLY_CANARY.value } },
        asMap: new Map([[key, KEY_ONLY_CANARY.value]]),
        asList: [{ [key]: KEY_ONLY_CANARY.value }],
      });
      logger[level]('keyed error', Object.assign(new Error('x'), { [key]: KEY_ONLY_CANARY.value }));
    }
    child[level]('child with secret bindings');
  }
}

const ALL: readonly Canary[] = [...PATTERN_CANARIES, KEY_ONLY_CANARY];

describe('secret canaries (@agentlink/log)', () => {
  it('no canary appears in any captured line at any level', async () => {
    await assertNoCanaryLeaks({ canaries: ALL, exercise, minLines: 100 });
  });

  it('the exercise really logs every level', async () => {
    const seen = new Set<string>();
    await assertNoCanaryLeaks({
      canaries: ALL,
      exercise: (run) => {
        exercise({
          ...run,
          logger: new Proxy(run.logger, {
            get(target, property, receiver) {
              if (typeof property === 'string' && (LEVELS as readonly string[]).includes(property))
                seen.add(property);
              return Reflect.get(target, property, receiver);
            },
          }),
        });
      },
    });
    expect([...seen].sort()).toEqual([...LEVELS].sort());
  });
});
