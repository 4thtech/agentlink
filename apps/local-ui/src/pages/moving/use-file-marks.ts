// U3-map-2: the Files page's marks. One flow read (the Agents map's poller) plus one Contacts read to
// turn a row's owner-confirmed name into a contact. A failed read gives no mark and no error.
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { createFlowApi } from '../agents/map/api.js';
import { fileMarks, namesToIds, type FileRowRef, type Moving } from './data.js';
import { useMoving } from './use-moving.js';

const FILES = ['file'] as const;

export type FileMarker = (
  side: 'in' | 'out',
  rows: readonly FileRowRef[],
) => ReadonlyMap<string, Moving>;

export function useFileMarks(client: ApiClient): FileMarker {
  const moving = useMoving(client, FILES);
  const [ids, setIds] = useState<ReadonlyMap<string, string>>(new Map());
  const hasMoving = moving.size > 0;
  useEffect(() => {
    // Contacts are read only while something is moving.
    if (!hasMoving) return undefined;
    let live = true;
    void createFlowApi(client)
      .contacts()
      .then((r) => {
        if (live && r.kind === 'ok') setIds(namesToIds(r.contacts));
      });
    return () => {
      live = false;
    };
  }, [client, hasMoving]);
  return useMemo(() => (side, rows) => fileMarks(side, rows, ids, moving), [ids, moving]);
}
