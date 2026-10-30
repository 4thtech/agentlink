// W4-MOTION-KIT (S0): optimistic items (W4 UX v2, "Loading": messages you send appear at once, then
// confirm). An added item shows at once as pending. When the confirmed list holds its id, the
// confirmed copy takes its place in the same position, so nothing flashes or jumps. confirm() before
// the list catches up keeps it shown as confirmed; fail() keeps it, marked failed, for a retry;
// dismiss() removes it. Rendering (dimmed while pending, the failed word) is the caller's, with the
// kit's `.al-optimistic[data-state]` styles.
import { useCallback, useEffect, useMemo, useState } from 'react';

export type OptimisticState = 'confirmed' | 'pending' | 'failed';

export interface OptimisticEntry<T> {
  item: T;
  state: OptimisticState;
}

export interface OptimisticHandle {
  confirm(): void;
  fail(): void;
  dismiss(): void;
}

/** Confirmed items first (in their order), then local items whose id is not confirmed yet. */
export function mergeOptimistic<T extends { id: string }>(
  confirmed: readonly T[],
  local: readonly OptimisticEntry<T>[],
): OptimisticEntry<T>[] {
  const ids = new Set(confirmed.map((c) => c.id));
  return [
    ...confirmed.map((item) => ({ item, state: 'confirmed' as const })),
    ...local.filter((e) => !ids.has(e.item.id)),
  ];
}

/** Optimistic items on top of a confirmed list. */
export function useOptimisticItems<T extends { id: string }>(
  confirmed: readonly T[],
): { items: OptimisticEntry<T>[]; add(item: T): OptimisticHandle } {
  const [local, setLocal] = useState<OptimisticEntry<T>[]>([]);
  const add = useCallback((item: T): OptimisticHandle => {
    setLocal((prev) => [...prev.filter((e) => e.item.id !== item.id), { item, state: 'pending' }]);
    const set = (state: OptimisticState): void =>
      setLocal((prev) => prev.map((e) => (e.item.id === item.id ? { item: e.item, state } : e)));
    return {
      confirm: () => set('confirmed'),
      fail: () => set('failed'),
      dismiss: () => setLocal((prev) => prev.filter((e) => e.item.id !== item.id)),
    };
  }, []);
  // Once the confirmed list holds an id, the local copy is done: forget it, so it can never come
  // back stale if the confirmed list later drops that id.
  useEffect(() => {
    const ids = new Set(confirmed.map((c) => c.id));
    setLocal((prev) =>
      prev.some((e) => ids.has(e.item.id)) ? prev.filter((e) => !ids.has(e.item.id)) : prev,
    );
  }, [confirmed]);
  const items = useMemo(() => mergeOptimistic(confirmed, local), [confirmed, local]);
  return { items, add };
}
