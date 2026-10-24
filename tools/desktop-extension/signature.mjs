// M1-9f (D-91): the MCPB signature block, as written and read by the reference tool
// @anthropic-ai/mcpb 2.1.2 (dist/node/sign.js, signMcpbFile / extractSignatureBlock):
//
//   <zip bytes> "MCPB_SIG_V1" <uint32 little-endian length> <PKCS#7 SignedData, DER, detached> "MCPB_SIG_END"
//
// The PKCS#7 signature covers the zip bytes (SHA-256 digest; authenticated attributes contentType,
// messageDigest, signingTime). tools/desktop-extension/sign.sh makes it with `openssl cms -sign`, so
// no third-party signing package runs in the job that holds the key.
//
// CLI (used by sign.sh and verify.sh):
//   node signature.mjs append  <bundle> <signature.der>      appends the block in place
//   node signature.mjs extract <bundle> <content-out> <signature-out>   exits 1 if unsigned

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADER = Buffer.from('MCPB_SIG_V1', 'utf8');
const FOOTER = Buffer.from('MCPB_SIG_END', 'utf8');

/** `content` followed by the signature block for `signature` (DER). */
export function appendSignatureBlock(content, signature) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signature.length, 0);
  return Buffer.concat([content, HEADER, length, signature, FOOTER]);
}

/**
 * Splits a signed bundle into `{ content, signature }`, or returns null when the bytes do not end
 * with a well-formed block (stricter than the reference reader: the footer must be the last bytes
 * and the length must match exactly).
 */
export function extractSignatureBlock(bytes) {
  if (bytes.length < HEADER.length + 4 + FOOTER.length) return null;
  if (!bytes.subarray(bytes.length - FOOTER.length).equals(FOOTER)) return null;
  const end = bytes.length - FOOTER.length;
  for (let h = end - 4 - HEADER.length; h >= 0; h -= 1) {
    if (!bytes.subarray(h, h + HEADER.length).equals(HEADER)) continue;
    const length = bytes.readUInt32LE(h + HEADER.length);
    const start = h + HEADER.length + 4;
    if (start + length !== end) continue;
    return { content: bytes.subarray(0, h), signature: bytes.subarray(start, end) };
  }
  return null;
}

function main([command, ...args]) {
  if (command === 'append' && args.length === 2) {
    const [bundle, sig] = args;
    const content = readFileSync(bundle);
    if (extractSignatureBlock(content)) throw new Error('bundle is already signed');
    writeFileSync(bundle, appendSignatureBlock(content, readFileSync(sig)));
    return 0;
  }
  if (command === 'extract' && args.length === 3) {
    const [bundle, contentOut, sigOut] = args;
    const parts = extractSignatureBlock(readFileSync(bundle));
    if (!parts) {
      console.error('The bundle has no MCPB signature block.');
      return 1;
    }
    writeFileSync(contentOut, parts.content);
    writeFileSync(sigOut, parts.signature);
    return 0;
  }
  console.error(
    'usage: signature.mjs append <bundle> <sig.der> | extract <bundle> <content-out> <sig-out>',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
