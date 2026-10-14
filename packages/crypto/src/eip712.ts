// RED stub (M1-1e): EIP-712 typed-data hashing. Implementation follows.
const todo = (): never => {
  throw new Error('M1-1e: not implemented');
};

export interface TypedDataField {
  readonly name: string;
  readonly type: string;
}

export type TypedDataTypes = Readonly<Record<string, readonly TypedDataField[]>>;

export interface TypedData {
  readonly types: TypedDataTypes;
  readonly primaryType: string;
  readonly domain: Readonly<Record<string, unknown>>;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface TypedDataHashes {
  readonly domainSeparator: Uint8Array;
  readonly structHash: Uint8Array;
  readonly digest: Uint8Array;
}

export function eip712EncodeType(types: TypedDataTypes, primaryType: string): string {
  void types;
  void primaryType;
  return todo();
}

export function eip712TypeHash(types: TypedDataTypes, primaryType: string): Uint8Array {
  void types;
  void primaryType;
  return todo();
}

export function eip712HashStruct(
  types: TypedDataTypes,
  primaryType: string,
  data: Readonly<Record<string, unknown>>,
): Uint8Array {
  void types;
  void primaryType;
  void data;
  return todo();
}

export function hashTypedData(typedData: TypedData): TypedDataHashes {
  void typedData;
  return todo();
}

export function signTypedData(typedData: TypedData, secretKey: Uint8Array): string {
  void typedData;
  void secretKey;
  return todo();
}
