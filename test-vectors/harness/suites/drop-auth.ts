// Suite `drop-auth` (M1-27a, D-48): the encrypted drop's request signature and URL MAC (07 §5.4)
// through @agentlink/crypto. `urlMac` computes the MAC, `authEvent` the body hash and NIP-01 id of the
// unsigned kind-27235 event, and `verify` runs verifyDropAuthorization: accept with the drop key, or
// reject with its reason. Decimal strings carry the integers (the vector format has string values).
import {
  decodeHex,
  dropAuthEvent,
  dropUrlMac,
  encodeHex,
  nostrEventId,
  verifyDropAuthorization,
  type DropUrlPurpose,
} from '@agentlink/crypto';
import type { Comparison, SuiteModule } from '../suite';

type DropAuthInput =
  | {
      op: 'urlMac';
      key: string;
      purpose: DropUrlPurpose;
      objectId: string;
      part: string;
      expiresAt: string;
    }
  | {
      op: 'authEvent';
      method: string;
      url: string;
      body: string;
      createdAt: string;
      pubkey: string;
    }
  | { op: 'verify'; authorization: string; method: string; url: string; body: string; now: string };

function parseInput(input: unknown): DropAuthInput {
  const i = input as Record<string, unknown> | null;
  const strings = (...keys: string[]): boolean => keys.every((key) => typeof i?.[key] === 'string');
  if (i?.op === 'urlMac' && strings('key', 'purpose', 'objectId', 'part', 'expiresAt')) {
    return i as DropAuthInput;
  }
  if (i?.op === 'authEvent' && strings('method', 'url', 'body', 'createdAt', 'pubkey')) {
    return i as DropAuthInput;
  }
  if (i?.op === 'verify' && strings('authorization', 'method', 'url', 'body', 'now')) {
    return i as DropAuthInput;
  }
  throw new TypeError('drop-auth: input does not match any op of case.schema.json');
}

function evaluateInput(input: DropAuthInput): readonly Comparison[] {
  switch (input.op) {
    case 'urlMac': {
      const mac = dropUrlMac(decodeHex(input.key), {
        purpose: input.purpose,
        objectId: decodeHex(input.objectId),
        part: Number(input.part),
        expiresAt: Number(input.expiresAt),
      });
      return [{ field: 'mac', actual: encodeHex(mac) }];
    }
    case 'authEvent': {
      const event = dropAuthEvent(
        { method: input.method, url: input.url, body: decodeHex(input.body) },
        Number(input.createdAt),
      );
      const payload = event.tags.find((tag) => tag[0] === 'payload')?.[1] ?? '';
      return [
        { field: 'payload', actual: payload },
        { field: 'eventId', actual: nostrEventId(input.pubkey, event) },
      ];
    }
    case 'verify': {
      const result = verifyDropAuthorization(
        input.authorization,
        { method: input.method, url: input.url, body: decodeHex(input.body) },
        Number(input.now),
      );
      return result.ok
        ? [
            { field: 'outcome', actual: 'accept' },
            { field: 'pubkey', actual: result.pubkey },
          ]
        : [
            { field: 'outcome', actual: 'reject' },
            { field: 'reason', actual: result.reason },
          ];
    }
  }
}

export const dropAuth: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluateInput(parseInput(testCase.input)));
  },
};
