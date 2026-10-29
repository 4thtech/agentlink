// U3-k: a keychain stand-in for the local-app end-to-end test: a JSON file in a temp folder, so the
// OS keychain is never touched. It has the shape of @4thtech-io/node's KeychainBackend
// (get / set / delete of a byte string by account name). The file lives outside every agent home.
import { readFileSync, writeFileSync } from 'node:fs';

const toBase64url = (bytes) => Buffer.from(bytes).toString('base64url');

export class FileKeychain {
  #file;
  constructor(file) {
    this.#file = file;
  }
  #read() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return {};
    }
  }
  get(account) {
    const value = this.#read()[account];
    return Promise.resolve(
      value === undefined ? null : new Uint8Array(Buffer.from(value, 'base64url')),
    );
  }
  set(account, value) {
    writeFileSync(this.#file, JSON.stringify({ ...this.#read(), [account]: toBase64url(value) }), {
      mode: 0o600,
    });
    return Promise.resolve();
  }
  delete(account) {
    const items = this.#read();
    const had = account in items;
    delete items[account];
    writeFileSync(this.#file, JSON.stringify(items), { mode: 0o600 });
    return Promise.resolve(had);
  }
}
