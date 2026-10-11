import { useEffect, useRef, useState } from "react";

type Loader<T> = (key: string) => Promise<T>;
const RETRY_DELAYS_MS = [3000, 6000];

export interface AsyncData<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown | null;
}

interface Request<T> {
  key: string;
  loader: Loader<T>;
  result: AsyncData<T>;
  attempts: number;
  pending: boolean;
  retryAt: number;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Null disables loading. Cache the latest request, including success or failure,
 * per hook instance. Keep loader and shouldRetry functions stable.
 * Opt-in retries wait 3s then 6s, with at most three attempts total. Re-enabling
 * preserves that budget; disabling pauses retries but lets an in-flight load finish.
 */
export function useAsyncData<T>(
  key: string | null,
  loader: Loader<T>,
  { shouldRetry }: { shouldRetry?: (error: unknown) => boolean } = {},
): AsyncData<T> {
  const cache = useRef<Request<T> | null>(null);
  const mounted = useRef(false);
  const [state, setState] = useState<{
    key: string;
    loader: Loader<T>;
    result: AsyncData<T>;
  } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (key === null) return;
    if (cache.current?.key !== key || cache.current.loader !== loader) {
      cache.current = {
        key,
        loader,
        result: { data: undefined, loading: true, error: null },
        attempts: 0,
        pending: false,
        retryAt: 0,
        active: false,
      };
    }
    const request = cache.current;
    request.active = true;

    const publish = () => {
      // Keep completed data available even when temporarily disabled, but never
      // let an old resource overwrite the current cache or update after unmount.
      if (mounted.current && cache.current === request) {
        setState({ key, loader, result: request.result });
      }
    };
    const run = () => {
      request.pending = true;
      request.attempts++;
      Promise.resolve()
        .then(() => loader(key))
        .then(
          (data) => {
            request.pending = false;
            request.result = { data, loading: false, error: null };
            publish();
          },
          (error) => {
            request.pending = false;
            const delay = RETRY_DELAYS_MS[request.attempts - 1];
            if (delay !== undefined && shouldRetry?.(error)) {
              request.retryAt = Date.now() + delay;
              // Stay loading until success or the retry budget is exhausted.
              schedule();
            } else {
              request.result = { data: undefined, loading: false, error };
            }
            publish();
          },
        );
    };
    const schedule = () => {
      if (!request.active || request.pending || !request.result.loading) return;
      const wait = request.retryAt - Date.now();
      if (wait > 0) request.timer = setTimeout(run, wait);
      else run();
    };
    publish();
    schedule();
    return () => {
      request.active = false;
      clearTimeout(request.timer);
    };
  }, [key, loader, shouldRetry]);

  if (key !== null && state?.key === key && state.loader === loader)
    return state.result;
  return { data: undefined, loading: key !== null, error: null };
}
