/**
 * @vitest-environment happy-dom
 */
import { clientRoot, createClient, view } from '@nkzw/fate';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vite-plus/test';
import { FateClient } from '../context.tsx';
import { useRequestState } from '../useRequestState.tsx';

// @ts-expect-error React test environment.
global.IS_REACT_ACT_ENVIRONMENT = true;

type User = { __typename: 'User'; id: string; name: string };
const UserView = view<User>()({ id: true, name: true });
const request = { viewer: { view: UserView } };
const setup = () => {
  const fetchQuery = vi.fn(async () => ({ id: '1', name: 'Ada' }));
  const client = createClient({
    roots: { viewer: clientRoot<User | null, 'User'>('User') },
    transport: { fetchById: vi.fn(async () => []), fetchQuery },
    types: [{ type: 'User' }],
  });
  return { client, fetchQuery };
};

test('does not fetch disabled requests and starts when enabled with stable inline inputs', async () => {
  const { client, fetchQuery } = setup();
  const element = document.createElement('div');
  const root = createRoot(element);
  function Search({ enabled }: { enabled: boolean }) {
    const result = useRequestState({ viewer: { view: UserView } }, { enabled });
    return (
      <span>
        {result.status}:{result.data?.viewer?.id}
      </span>
    );
  }
  const render = (enabled: boolean) =>
    act(async () =>
      root.render(
        <FateClient client={client}>
          <Search enabled={enabled} />
        </FateClient>,
      ),
    );
  await render(false);
  expect(element.textContent).toBe('disabled:');
  expect(fetchQuery).not.toHaveBeenCalled();
  await render(true);
  expect(element.textContent).toBe('ready:1');
  await render(true);
  expect(fetchQuery).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

test('observes a cache-only miss becoming a complete nullable result without fetching', async () => {
  const { client, fetchQuery } = setup();
  const element = document.createElement('div');
  const root = createRoot(element);
  function Cached() {
    const result = useRequestState(request, { mode: 'cache-only' });
    return (
      <span>
        {result.status}:{result.data?.viewer === null ? 'null' : result.data?.viewer?.id}
      </span>
    );
  }
  await act(async () =>
    root.render(
      <FateClient client={client}>
        <Cached />
      </FateClient>,
    ),
  );
  expect(element.textContent).toBe('missing:');
  expect(fetchQuery).not.toHaveBeenCalled();
  await act(async () => {
    await client.request(request);
  });
  expect(element.textContent).toBe('ready:1');
  fetchQuery.mockResolvedValueOnce(null as never);
  await act(async () => {
    await client.request(request, { mode: 'network-only' });
  });
  expect(element.textContent).toBe('ready:null');
  expect(fetchQuery).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

test('does not expose an incomplete cache selection or fetch missing view fields', async () => {
  const { client } = setup();
  client.write('User', { id: '1' }, new Set(['id']));
  const observer = client.observeRequest(
    { viewer: { id: '1', view: UserView } },
    { mode: 'cache-only' },
  );
  const dispose = observer.subscribe(() => {});
  expect(observer.getSnapshot()).toMatchObject({ data: undefined, status: 'missing' });
  client.write('User', { id: '1', name: 'Ada' }, new Set(['id', 'name']));
  const result = observer.getSnapshot();
  expect(result.status).toBe('ready');
  client.deleteRecord('User', '1');
  await expect(
    Promise.resolve().then(() => client.readView(UserView, result.data!.viewer)),
  ).rejects.toThrow(/cache/i);
  dispose();
});

test('reports initial failures without suspending or losing the original error', async () => {
  const { client, fetchQuery } = setup();
  const error = new Error('Offline');
  fetchQuery.mockRejectedValueOnce(error);
  const observer = client.observeRequest(request);
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(observer.getSnapshot()).toMatchObject({ error, isFetching: false, status: 'error' }),
  );
  unsubscribe();
});

test('notifies cache-only observers about optimistic deletion and rollback', async () => {
  const { client } = setup();
  await client.request(request);
  const observer = client.observeRequest(
    { viewer: { id: '1', view: UserView } },
    { mode: 'cache-only' },
  );
  const listener = vi.fn();
  const unsubscribe = observer.subscribe(listener);
  expect(observer.getSnapshot().status).toBe('ready');
  await Promise.resolve();
  listener.mockClear();
  const settle = client.store.optimisticUpdate(() => client.deleteRecord('User', '1'));
  await Promise.resolve();
  expect(listener).toHaveBeenCalled();
  expect(observer.getSnapshot().status).toBe('missing');
  settle();
  await Promise.resolve();
  expect(observer.getSnapshot().status).toBe('ready');
  unsubscribe();
});
