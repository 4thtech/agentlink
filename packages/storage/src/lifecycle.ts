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
// The rule also aborts incomplete multipart uploads under `agentlink/` after a day, the backstop for an
// upload whose own abort failed.
//
// Changing a bucket's lifecycle is a bucket-level permission, which the recommended bucket-scoped key
// (07 §5.2: object read, write and delete, plus multipart abort and listing) does not have; the caller maps `lifecycle_failed` with status 403
// to "add the rule in the provider's console" guidance.
import { encodeBase64url, encodeHex, sha256 } from '@4thtech-io/crypto';
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
/**
 * Incomplete multipart uploads under `agentlink/` are aborted this many days after they start: the
 * backstop for an upload whose abort failed (multipart.ts). Expiration alone does not remove them.
 */
export const LIFECYCLE_ABORT_INCOMPLETE_DAYS = 1;
const MAX_DAYS = 3650;
const MAX_DOCUMENT_BYTES = 256 * 1024;
/** S3's limit on rules per bucket. */
const MAX_RULES = 1000;
/** Tries to write a lifecycle update while the bucket's configuration keeps changing. */
const MAX_ATTEMPTS = 3;

export type S3LifecycleConfig = S3SessionConfig;

export interface LifecycleRuleState {
  readonly prefix: string;
  readonly days: number;
  /** Days after which incomplete multipart uploads are aborted, or null when the rule has none. */
  readonly abortIncompleteDays: number | null;
  readonly enabled: boolean;
}

/** What `apply` reports on success (M1-6b-d). */
export interface LifecycleApplyResult {
  /**
   * `dropped` when the provider kept the expiry rule but silently left out the abort-incomplete-upload
   * element (some S3-compatible providers do), so unfinished uploads are not cleaned up automatically.
   */
  readonly abortIncomplete: 'kept' | 'dropped';
  /** Plain-words text for the owner when `abortIncomplete` is `dropped`; null otherwise. */
  readonly warning: string | null;
}

/** 11 §5 plain words: no provider jargon, no URL, no bucket name. */
export const LIFECYCLE_ABORT_DROPPED_WARNING =
  'Your storage provider did not accept the clean-up of unfinished uploads. Files are still removed on time, but an upload that is interrupted may leave unused data in your storage until you delete it there.';

export interface S3Lifecycle {
  /** Sets (or replaces) the AgentLink rule; keeps the bucket's other rules. */
  apply(opts?: { readonly days?: number }): Promise<LifecycleApplyResult>;
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

interface RuleNode {
  readonly name: string;
  readonly children: RuleNode[];
  text: string;
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Parses one `<Rule>` into a small tree; null when the markup is not well formed. */
function parseRule(rule: string): RuleNode | null {
  const root: RuleNode = { name: '#root', children: [], text: '' };
  const stack: RuleNode[] = [root];
  const token = /<(\/?)([A-Za-z][A-Za-z0-9]*)[^<>]*?(\/?)>|([^<]+)/g;
  for (let m = token.exec(rule); m !== null; m = token.exec(rule)) {
    const top = stack[stack.length - 1] as RuleNode;
    if (m[4] !== undefined) {
      top.text += m[4];
    } else if (m[1] === '/') {
      if (stack.length < 2 || top.name !== m[2]) return null;
      stack.pop();
    } else {
      const node: RuleNode = { name: m[2] as string, children: [], text: '' };
      top.children.push(node);
      if (m[3] !== '/') stack.push(node);
    }
  }
  return stack.length === 1 && root.children.length === 1 ? (root.children[0] as RuleNode) : null;
}

/**
 * A canonical string for a node: children sorted, empty elements dropped, `And` unwrapped, so element
 * order, empty placeholders and an equivalent re-serialisation by the provider compare equal while any
 * element with a value still counts.
 */
function canon(node: RuleNode): string {
  const flat: RuleNode[] = [];
  for (const child of node.children) {
    if (child.name === 'And') flat.push(...child.children);
    else flat.push(child);
  }
  const parts = flat
    .filter(
      (child) => !(child.name === 'ExpiredObjectDeleteMarker' && child.text.trim() === 'false'),
    )
    .map(canon)
    .filter((part) => part !== '')
    .sort();
  const text = decodeXml(node.text.trim());
  if (parts.length === 0 && text === '') return '';
  return `${node.name}(${text}|${parts.join(',')})`;
}

/** The rule as the provider holds it, without the multipart-abort element (checked separately). */
function ruleSignature(rule: string, keepAbort: boolean): string | null {
  const tree = parseRule(rule);
  if (tree === null) return null;
  // A prefix directly on the rule (older form) is the same as one inside the filter.
  const legacy = tree.children.filter((child) => child.name === 'Prefix');
  if (legacy.length > 0) {
    const filter = tree.children.find((child) => child.name === 'Filter');
    const target = filter ?? { name: 'Filter', children: [], text: '' };
    if (filter === undefined) tree.children.push(target);
    target.children.push(...legacy);
    tree.children.splice(
      0,
      tree.children.length,
      ...tree.children.filter((c) => !legacy.includes(c)),
    );
  }
  if (!keepAbort) {
    const rest = tree.children.filter((child) => child.name !== 'AbortIncompleteMultipartUpload');
    tree.children.splice(0, tree.children.length, ...rest);
  }
  return canon(tree);
}

/**
 * Whether two rules mean the same thing (M1-6b-c): compared as parsed content, not as text, because
 * MinIO, R2 and S3 each re-serialise a stored rule differently (element order, empty placeholders).
 */
function sameRule(a: string, b: string): boolean {
  const left = ruleSignature(a, true);
  return left !== null && left === ruleSignature(b, true);
}

/**
 * Whether `after` is our own rule for `days`. A provider may drop the multipart-abort element (MinIO
 * accepts it and keeps its own stale-upload expiry), so it may be absent but never different.
 */
function ownRuleHolds(after: string, days: number): boolean {
  const expected = ownRuleXml(days);
  const left = ruleSignature(after, false);
  if (left === null || left !== ruleSignature(expected, false)) return false;
  const initiation = xmlText(after, 'DaysAfterInitiation');
  return (
    initiation === null ||
    initiation.trim() === '' ||
    initiation.trim() === String(LIFECYCLE_ABORT_INCOMPLETE_DAYS)
  );
}

function ownRuleXml(days: number): string {
  return (
    `<Rule><ID>${LIFECYCLE_RULE_ID}</ID><Filter><Prefix>${LIFECYCLE_PREFIX}</Prefix></Filter>` +
    `<Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration>` +
    `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${LIFECYCLE_ABORT_INCOMPLETE_DAYS}</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>`
  );
}

/** A small non-negative integer from `<tag>` inside `<block>` of `rule`, or null. */
function blockNumber(rule: string, block: string, tag: string): number | null {
  const inner = new RegExp(`<${block}>([\\s\\S]*?)</${block}>`).exec(rule)?.[1];
  const text = inner === undefined ? null : xmlText(inner, tag);
  return text !== null && /^[0-9]{1,5}$/.test(text) ? Number(text) : null;
}

function parseOwnRule(rule: string): LifecycleRuleState {
  const prefix = xmlText(rule, 'Prefix');
  const status = xmlText(rule, 'Status');
  const days = blockNumber(rule, 'Expiration', 'Days');
  if (prefix === null || (status !== 'Enabled' && status !== 'Disabled') || days === null) {
    throw failed();
  }
  return {
    prefix,
    days,
    abortIncompleteDays: blockNumber(rule, 'AbortIncompleteMultipartUpload', 'DaysAfterInitiation'),
    enabled: status === 'Enabled',
  };
}

export function createS3Lifecycle(config: S3LifecycleConfig): S3Lifecycle {
  const session: S3Session = createS3Session(config, 's3-lifecycle');
  const { log } = session;
  const lifecycleUrl = (): string => {
    const url = new URL(session.bucketUrl);
    url.searchParams.set('lifecycle', '');
    return url.toString();
  };

  /**
   * The bucket's rules as raw `<Rule>` elements; [] when it has no lifecycle configuration.
   * `complete` is false when the document holds a rule element this parser did not extract (for
   * example `<Rule attr="...">`): writing then would silently drop that rule.
   */
  async function currentRules(): Promise<{ rules: string[]; complete: boolean }> {
    const response = await session.send(lifecycleUrl(), { method: 'GET' });
    const text = await readCappedText(response, MAX_DOCUMENT_BYTES);
    if (response.status === 404 && text !== null && text.includes('NoSuchLifecycleConfiguration')) {
      return { rules: [], complete: true };
    }
    if (!response.ok || text === null || !text.includes('<LifecycleConfiguration')) {
      log?.warn('storage lifecycle read failed', { status: response.status });
      throw failed(response.status);
    }
    const rules = text.match(/<Rule>[\s\S]*?<\/Rule>/g) ?? [];
    if (rules.length > MAX_RULES) throw failed(response.status);
    const elements = text.match(/<Rule(?=[\s>/])/g)?.length ?? 0;
    return { rules, complete: elements === rules.length };
  }

  return {
    async apply(opts = {}): Promise<LifecycleApplyResult> {
      const days = opts.days ?? LIFECYCLE_DEFAULT_DAYS;
      if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
        throw new StorageError(
          'invalid_argument',
          'lifecycle days must be an integer from 1 to 3650',
        );
      }
      // S3 has no conditional write for the lifecycle configuration, so the read-modify-write cannot be
      // made atomic (M1-6b-b L3). It is made safe as far as the API allows: read twice and write only
      // when both reads agree (a change in between is retried from the start), then read the result
      // back and check that every rule is still there with the same content. A change that lands between the second read and the
      // write is the one window left; the read-back reports it instead of hiding it.
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = await currentRules();
        if (!current.complete) {
          log?.warn('storage lifecycle document not understood; nothing written');
          throw failed();
        }
        const again = await currentRules();
        if (again.rules.join('') !== current.rules.join('')) {
          log?.debug('storage lifecycle changed during update; retrying', { attempt });
          continue;
        }
        const others = current.rules.filter((rule) => ruleId(rule) !== LIFECYCLE_RULE_ID);
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
        const after = (await currentRules()).rules;
        // Full content, not just IDs (M1-6b-c): a rule another writer changed in place keeps its ID.
        const ownAfter = after.find((rule) => ruleId(rule) === LIFECYCLE_RULE_ID);
        if (
          ownAfter === undefined ||
          !ownRuleHolds(ownAfter, days) ||
          !others.every((rule) => after.some((candidate) => sameRule(candidate, rule)))
        ) {
          log?.warn('storage lifecycle changed after the update');
          throw failed();
        }
        const dropped = !/<AbortIncompleteMultipartUpload[\s>]/.test(ownAfter);
        log?.info('storage lifecycle rule applied', { days, otherRules: others.length });
        if (dropped) {
          log?.warn('storage provider dropped the abort-incomplete-upload rule');
          return { abortIncomplete: 'dropped', warning: LIFECYCLE_ABORT_DROPPED_WARNING };
        }
        return { abortIncomplete: 'kept', warning: null };
      }
      log?.warn('storage lifecycle kept changing; nothing written');
      throw failed();
    },

    async read(): Promise<LifecycleRuleState | null> {
      const own = (await currentRules()).rules.find((rule) => ruleId(rule) === LIFECYCLE_RULE_ID);
      return own === undefined ? null : parseOwnRule(own);
    },
  };
}
