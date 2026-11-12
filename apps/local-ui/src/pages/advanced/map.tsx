// Advanced › Connections map (W4-SETTINGS-ADVANCED). The same live map as the Map view on My IDs,
// drawn from the same reads; never a second, different picture and never a "coming next" stub.
import { Skeleton } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { AgentsMap } from '../agents/map/index.js';
import { useAgents } from '../agents/use-agents.js';

export const MAP_STRINGS = {
  title: 'Connections map',
  unknown: "Couldn't load your IDs.",
} as const;

export function ConnectionsMapPage(): ReactElement {
  const { state } = useAgents(undefined);
  const list = state.kind === 'ready' ? state.list : (state.last ?? undefined);
  return (
    <>
      <h1 className="al-text-title-1">{MAP_STRINGS.title}</h1>
      <Skeleton loading={state.kind === 'loading' && list === undefined} lines={3}>
        {list === undefined ? (
          <p className="al-text-body al-muted">{MAP_STRINGS.unknown}</p>
        ) : (
          <AgentsMap agents={list.agents} />
        )}
      </Skeleton>
    </>
  );
}
