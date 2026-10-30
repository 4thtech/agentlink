// W4-AGENTS: the reads of an agent's own page. People and rules are the open agent's (the app host
// serves them for the agent that is open); another agent's page says so and offers to open it. Both
// are parsed by their own pages' parsers; names are shown under the name rule (11 §5.2), never as
// markup (I-5).
import { createApiClient } from '../../api/client.js';
import { LIST_PATH, parseList, type ContactRow } from '../contacts/data.js';
import { parseRules, RULES_PATH, type RulesView } from '../rules/data.js';

export type PeopleRead =
  { readonly kind: 'ok'; readonly people: readonly ContactRow[] } | { readonly kind: 'error' };
export type RulesRead =
  { readonly kind: 'ok'; readonly rules: RulesView } | { readonly kind: 'error' };

export interface DetailApi {
  people(): Promise<PeopleRead>;
  rules(): Promise<RulesRead>;
}

export function createDetailApi(options: { fetch?: typeof fetch; token?: string } = {}): DetailApi {
  const client = createApiClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  return {
    async people() {
      const res = await client.get(LIST_PATH);
      if (res.kind !== 'ok') return { kind: 'error' };
      const list = parseList(res.data);
      return list.kind === 'ok'
        ? { kind: 'ok', people: list.contacts.filter((c) => c.status === 'active') }
        : { kind: 'error' };
    },
    async rules() {
      const res = await client.get(RULES_PATH);
      if (res.kind !== 'ok') return { kind: 'error' };
      const read = parseRules(res.data);
      return read.kind === 'ok' ? { kind: 'ok', rules: read.rules } : { kind: 'error' };
    },
  };
}
