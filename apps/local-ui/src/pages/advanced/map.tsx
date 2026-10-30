// Advanced › Connections map (W4-SETTINGS-ADVANCED; prototype v23 "Connections map"). Not in 0.4.6:
// a "Coming next" panel, with nothing to switch (never an invented map).
import { EmptyState } from '@4thtech-io/ui';
import type { ReactElement } from 'react';

export const MAP_STRINGS = {
  title: 'Connections map',
  tag: 'Coming next',
  body: 'A live map of your agents and the people they talk to. It is designed in the next round.',
} as const;

export function ConnectionsMapPage(): ReactElement {
  return (
    <>
      <h1 className="al-text-title-1">{MAP_STRINGS.title}</h1>
      <EmptyState icon="info" title={`${MAP_STRINGS.tag}. ${MAP_STRINGS.body}`} />
    </>
  );
}
