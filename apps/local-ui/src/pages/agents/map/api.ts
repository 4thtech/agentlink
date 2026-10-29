// U3-map: the flow read (`GET /api/ui/flow`, card U3-flow) and the Contacts read the map names
// people from. Plain GETs; nothing here can write.
import type { ApiClient } from '../../../api/client.js';
import { LIST_PATH, parseList, type ContactRow } from '../../contacts/data.js';
import { flowPath, parseFlow, type Flow } from './data.js';

export type FlowRead = { readonly kind: 'ok'; readonly flow: Flow } | { readonly kind: 'error' };
export type ContactsRead =
  { readonly kind: 'ok'; readonly contacts: readonly ContactRow[] } | { readonly kind: 'error' };

export interface FlowApi {
  read(since?: number): Promise<FlowRead>;
  contacts(): Promise<ContactsRead>;
}

/** The map's first read looks 24 hours back (the server never goes further). */
export const firstSince = (nowSec: number): number => nowSec - 86_400;

export function createFlowApi(client: ApiClient): FlowApi {
  return {
    async read(since) {
      const result = await client.get<unknown>(flowPath(since));
      if (result.kind !== 'ok') return { kind: 'error' };
      const flow = parseFlow(result.data);
      return flow === undefined ? { kind: 'error' } : { kind: 'ok', flow };
    },
    async contacts() {
      const result = await client.get<unknown>(LIST_PATH);
      if (result.kind !== 'ok') return { kind: 'error' };
      const list = parseList(result.data);
      return list.kind === 'ok' ? { kind: 'ok', contacts: list.contacts } : { kind: 'error' };
    },
  };
}
