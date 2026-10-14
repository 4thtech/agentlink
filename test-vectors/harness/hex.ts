const HEX = /^(?:[0-9a-f]{2})*$/;

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX.test(hex)) throw new TypeError('expected lowercase hex with an even number of digits');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
