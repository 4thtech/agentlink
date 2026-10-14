// RED stub (M1-1e): the AgentCard (04 §2.4). Implementation follows.
import type { TypedDataHashes, TypedDataTypes } from './eip712.js';

const todo = (): never => {
  throw new Error('M1-1e: not implemented');
};

export interface AgentCard {
  readonly version: number;
  readonly agentEvm: string;
  readonly agentNostr: string;
  readonly agentEnc: string;
  readonly ownerEvm: string;
  readonly ownerNostr: string;
  readonly ownerEnc: string;
  readonly nameHash: string;
  readonly relaysHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyEpoch: number;
}

export interface AgentCardHashes extends TypedDataHashes {
  readonly typeHash: Uint8Array;
}

export const AGENT_CARD_DOMAIN = Object.freeze({ name: 'OCC AgentCard', version: '1' } as const);
export const AGENT_CARD_TYPES: TypedDataTypes = Object.freeze({});

export function parseAgentCard(value: unknown): AgentCard {
  void value;
  return todo();
}

export function parseAgentCardJson(text: string): AgentCard {
  void text;
  return todo();
}

export function hashAgentCard(card: unknown): AgentCardHashes {
  void card;
  return todo();
}

export function agentCardJcsHash(card: unknown): Uint8Array {
  void card;
  return todo();
}

export function agentCardNameHash(name: string): Uint8Array {
  void name;
  return todo();
}

export function agentCardRelaysHash(relays: readonly string[]): Uint8Array {
  void relays;
  return todo();
}

export function signAgentCard(card: unknown, secretKey: Uint8Array): string {
  void card;
  void secretKey;
  return todo();
}

export function verifyCardOwnerSig(card: unknown, cardSig: unknown): boolean {
  void card;
  void cardSig;
  return todo();
}

export function verifyCardAgentSig(card: unknown, cardAgentSig: unknown): boolean {
  void card;
  void cardAgentSig;
  return todo();
}

export function verifyAgentCard(card: unknown, cardSig: unknown, cardAgentSig: unknown): boolean {
  void card;
  void cardSig;
  void cardAgentSig;
  return todo();
}
