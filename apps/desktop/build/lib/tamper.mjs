// Flips one byte in the JSON header of an ASAR buffer (the header is what the integrity digest covers).
export function tamperAsarHeader(buf) {
  const out = Buffer.from(buf);
  const at = out.indexOf('"offset"');
  if (at < 0) throw new Error('Not an ASAR header (no "offset" key).');
  out[at + 2] = out[at + 2] === 0x46 ? 0x47 : 0x46; // 'f' -> 'F' style change of the key name
  return out;
}
