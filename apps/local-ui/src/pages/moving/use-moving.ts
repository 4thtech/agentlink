// U3-map-2: the flow read for a list page, through the Agents map's own client and poller
// (`agents/map/use-flow.ts`: every 3 s while the tab is visible, nothing while hidden). A failed read
// shows no mark and no error: the row is just a row (b11 §32.3).
import { useMemo } from 'react';
import type { ApiClient } from '../../api/client.js';
import { createFlowApi } from '../agents/map/api.js';
import { useFlow } from '../agents/map/use-flow.js';
import { movingRows, type Kind, type MovingMap } from './data.js';

export function useMoving(client: ApiClient, kinds?: readonly Kind[]): MovingMap {
  const api = useMemo(() => createFlowApi(client), [client]);
  const state = useFlow(api);
  const kindKey = kinds?.join(',') ?? '';
  // Every good read changes `state.flow`, which also re-evaluates the one-minute window.
  return useMemo(
    () => movingRows(state.flow, state.nowSec(), kinds, !state.failed),
    [state.flow, state.failed, state.nowSec, kindKey],
  );
}
