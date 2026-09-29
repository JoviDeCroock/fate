import type {
  CheckedRequest,
  Request,
  RequestResult,
  RequestState,
  RequestStateOptions,
} from '@nkzw/fate';
import { useMemo, useSyncExternalStore } from 'react';
import { useFateClient } from './context.tsx';
import type { Roots } from './useRequest.tsx';

/** Observes request data without suspending; disabled and cache-only reads never fetch. */
export function useRequestState<const R extends Request>(
  request: CheckedRequest<Roots, R>,
  options: RequestStateOptions = {},
): RequestState<RequestResult<Roots, R>> {
  const client = useFateClient();
  const key = client.getRequestKey(request);
  const mode = options.mode ?? 'cache-first';
  const enabled = options.enabled !== false;
  const maxAge = options.persist?.maxAge;
  const observer = useMemo(
    () =>
      client.observeRequest(request, {
        enabled,
        mode,
        persist: maxAge === undefined ? undefined : { maxAge },
      }),
    // Equivalent inline selections share the same request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, key, mode, enabled, maxAge],
  );
  return useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getSnapshot,
  ) as RequestState<RequestResult<Roots, R>>;
}
