// UI-REFRESH-u: load a part of the app on first use. The chunk is fetched by a dynamic import; until it
// arrives the caller sees the shared skeleton (which stays hidden for the first 400 ms, so a fast load
// shows nothing at all). Once loaded, the component renders synchronously, so a second visit has no
// gap. A failed load shows a plain message and a button to try again. Nothing here delays navigation:
// the address and the layout change at once.
import { Button, Skeleton } from '@4thtech-io/ui';
import { useEffect, useReducer, useState, type ComponentType, type ReactElement } from 'react';
import { LAZY_STRINGS as S } from './strings.js';

export interface LazyPart<P extends object> {
  /** Start (or join) the load. Resolves when the chunk is ready; rejects when it cannot be fetched. */
  readonly load: () => Promise<void>;
  /** True once the chunk has arrived. */
  readonly ready: () => boolean;
  /** The component to render in place of the real one. */
  readonly Part: ComponentType<P>;
}

/** `fallback`: what shows while loading. Default: the shared skeleton. */
export function lazyPart<P extends object>(
  importer: () => Promise<ComponentType<P>>,
  fallback: () => ReactElement | null = () => <Skeleton loading lines={3} />,
): LazyPart<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<void> | undefined;

  const load = (): Promise<void> => {
    if (loaded !== undefined) return Promise.resolve();
    pending ??= importer().then(
      (component) => {
        loaded = component;
      },
      (error: unknown) => {
        pending = undefined; // a later try starts again
        throw error;
      },
    );
    return pending;
  };

  function Part(props: P): ReactElement | null {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const Ready = loaded;
    useEffect(() => {
      if (loaded !== undefined) return;
      let live = true;
      load().then(
        () => {
          if (live) rerender();
        },
        () => {
          if (live) setFailed(true);
        },
      );
      return () => {
        live = false;
      };
    }, [attempt]);
    if (Ready !== undefined) return <Ready {...props} />;
    if (failed) {
      return (
        <div className="al-lazy-failed" role="alert">
          <p className="al-text-body">{S.failed}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            {S.retry}
          </Button>
        </div>
      );
    }
    return fallback();
  }

  return { load, ready: () => loaded !== undefined, Part };
}
