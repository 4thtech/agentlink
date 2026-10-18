// The bucket lifecycle helper (07 §5.2, M1-6b part 1): `storage connect` offers a rule that deletes
// `agentlink/` objects after 30 days, as a safety net behind the per-file retention.
//
// - Sets one rule, identified by LIFECYCLE_RULE_ID, and keeps every other rule of the bucket exactly as
//   the provider returned it: S3 replaces the whole lifecycle configuration on PUT, so a helper that
//   wrote only its own rule would delete the user's rules. If the current configuration cannot be read,
//   nothing is written.
// - Reads the rule back, so the caller can show what is in force.
// - The PUT carries a SHA-256 checksum (`x-amz-checksum-sha256`), which S3 accepts in place of
//   Content-MD5 for this call.
// - The same rules as the adapter (s3.ts, 04 §4, I-7): endpoint grammar check before any request,
//   redirects refused, credentials per request and never logged, no URL, bucket name or provider
//   response text in a log or an error.
//
// Changing a bucket's lifecycle is a bucket-level permission, which the recommended bucket-scoped key
// (PutObject, GetObject, DeleteObject) does not have; the caller maps `lifecycle_failed` with status 403
// to "add the rule in the provider's console" guidance.
import { encodeBase64url, encodeHex, sha256 } from '@agentlink/crypto';
import { StorageError } from './errors.js';
import {
  createS3Session,
  discard,
  readCappedText,
  xmlText,
  type S3Session,
  type S3SessionConfig,
} from './session.js';

/** The ID of the rule this helper owns; other rules are never changed. */
export const LIFECYCLE_RULE_ID = 'agentlink-expire-objects';
/** Every AgentLink object key starts with this (07 §5.2). */
export const LIFECYCLE_PREFIX = 'agentlink/';
/** 07 §5.2: delete after 30 days. */
export const LIFECYCLE_DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
const MAX_DOCUMENT_BYTES = 256 * 1024;
/** S3's limit on rules per bucket. */
const MAX_RULES = 1000;

export type S3LifecycleConfig = S3SessionConfig;

export interface LifecycleRuleState {
  readonly prefix: string;
  readonly days: number;
  readonly enabled: boolean;
}

export interface S3Lifecycle {
  /** Sets (or replaces) the AgentLink rule; keeps the bucket's other rules. */
  apply(opts?: { readonly days?: number }): Promise<void>;
  /** The AgentLink rule as the provider reports it, or null when there is none. */
  read(): Promise<LifecycleRuleState | null>;
}

function failed(status?: number): StorageError {
  return new StorageError('lifecycle_failed', 'storage lifecycle request failed', status);
}

function toBase64(bytes: Uint8Array): string {
  const url = encodeBase64url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

function ruleId(rule: string): string | null {
  return xmlText(rule, 'ID');
}

function ownRuleXml(days: number): string {
  return (
    `<Rule><ID>${LIFECYCLE_RULE_ID}</ID><Filter><Prefix>${LIFECYCLE_PREFIX}</Prefix></Filter>` +
    `<Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule>`
  );
}

function parseOwnRule(rule: string): LifecycleRuleState {
  const prefix = xmlText(rule, 'Prefix');
  const status = xmlText(rule, 'Status');
  const expiration = /<Expiration>([\s\S]*?)<\/Expiration>/.exec(rule)?.[1];
  const daysText = expiration === undefined ? null : xmlText(expiration, 'Days');
  const days = daysText !== null && /^[0-9]{1,5}$/.test(daysText) ? Number(daysText) : Number.NaN;
  if (prefix === null || (status !== 'Enabled' && status !== 'Disabled') || Number.isNaN(days)) {
    throw failed();
  }
  return { prefix, days, enabled: status === 'Enabled' };
}

export function createS3Lifecycle(config: S3LifecycleConfig): S3Lifecycle {
  const session: S3Session = createS3Session(config, 's3-lifecycle');
  const { log } = session;
  const lifecycleUrl = (): string => {
    const url = new URL(session.bucketUrl);
    url.searchParams.set('lifecycle', '');
    return url.toString();
  };

  /** The bucket's rules as raw `<Rule>` elements; [] when it has no lifecycle configuration. */
  async function currentRules(): Promise<string[]> {
    const response = await session.send(lifecycleUrl(), { method: 'GET' });
    const text = await readCappedText(response, MAX_DOCUMENT_BYTES);
    if (response.status === 404 && text !== null && text.includes('NoSuchLifecycleConfiguration')) {
      return [];
    }
    if (!response.ok || text === null || !text.includes('<LifecycleConfiguration')) {
      log?.warn('storage lifecycle read failed', { status: response.status });
      throw failed(response.status);
    }
    const rules = text.match(/<Rule>[\s\S]*?<\/Rule>/g) ?? [];
    if (rules.length > MAX_RULES) throw failed(response.status);
    return rules;
  }

  return {
    async apply(opts = {}): Promise<void> {
      const days = opts.days ?? LIFECYCLE_DEFAULT_DAYS;
      if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
        throw new StorageError(
          'invalid_argument',
          'lifecycle days must be an integer from 1 to 3650',
        );
      }
      const others = (await currentRules()).filter((rule) => ruleId(rule) !== LIFECYCLE_RULE_ID);
      if (others.length + 1 > MAX_RULES) throw failed();
      const body = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          others.join('') +
          ownRuleXml(days) +
          '</LifecycleConfiguration>',
      );
      const digest = sha256(body);
      const response = await session.send(lifecycleUrl(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/xml',
          'X-Amz-Content-Sha256': encodeHex(digest),
          'x-amz-checksum-sha256': toBase64(digest),
          'x-amz-sdk-checksum-algorithm': 'SHA256',
        },
        body,
      });
      await discard(response);
      if (!response.ok) {
        log?.warn('storage lifecycle apply failed', { status: response.status });
        throw failed(response.status);
      }
      log?.info('storage lifecycle rule applied', { days, otherRules: others.length });
    },

    async read(): Promise<LifecycleRuleState | null> {
      const own = (await currentRules()).find((rule) => ruleId(rule) === LIFECYCLE_RULE_ID);
      return own === undefined ? null : parseOwnRule(own);
    },
  };
}
