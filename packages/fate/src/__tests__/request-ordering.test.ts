import { expect, test, vi } from 'vite-plus/test';
import { createClient } from '../client.ts';
import { clientRoot } from '../root.ts';
import { view } from '../view.ts';

type User = { __typename: 'User'; bio: string; id: string; name: string };
const Name = view<User>()({ id: true, name: true });
const Profile = view<User>()({ bio: true, id: true, name: true });
const setup = () => {
  const pending: Array<(record: Record<string, unknown> | null) => void> = [];
  const client = createClient({
    roots: { viewer: clientRoot<User | null, 'User'>('User') },
    transport: {
      fetchById: vi.fn(async () => []),
      fetchQuery: vi.fn(
        () => new Promise<Record<string, unknown> | null>((resolve) => pending.push(resolve)),
      ),
    },
    types: [{ type: 'User' }],
  });
  const start = (profile = false) =>
    client.request({ viewer: { view: profile ? Profile : Name } }, { mode: 'network-only' });
  return { client, pending, start };
};

test('older overlapping responses preserve newer fields and still fill disjoint fields', async () => {
  const { client, pending, start } = setup();
  const older = start(true);
  const newer = start();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]({ id: '1', name: 'New' });
  await newer;
  pending[0]({ bio: 'Biography', id: '1', name: 'Old' });
  await older;
  expect(client.store.read('User:1')).toMatchObject({ bio: 'Biography', name: 'New' });
});

test('older nullable root results cannot erase a newer root result', async () => {
  const { client, pending, start } = setup();
  const older = start(true);
  const newer = start();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]({ id: '1', name: 'New' });
  await newer;
  pending[0](null);
  await older;
  const result = await client.request({ viewer: { view: Name } });
  expect(result.viewer).toMatchObject({ id: '1' });
});

test('a late request cannot overwrite a confirmed local write or resurrect a deletion', async () => {
  const { client, pending, start } = setup();
  const older = start();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  client.write('User', { id: '1', name: 'Confirmed' }, new Set(['id', 'name']));
  pending[0]({ id: '1', name: 'Old' });
  await older;
  expect(client.store.read('User:1')?.name).toBe('Confirmed');
  const deleting = start();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  client.deleteRecord('User', '1');
  pending[1]({ id: '1', name: 'Resurrected' });
  await deleting;
  expect(client.store.read('User:1')).toBeUndefined();
});

test('requests update the confirmed base beneath optimistic writes and rollback reveals it', async () => {
  const { client, pending, start } = setup();
  client.write('User', { id: '1', name: 'Initial' }, new Set(['id', 'name']));
  const older = start();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const settle = client.store.optimisticUpdate(() =>
    client.write('User', { id: '1', name: 'Optimistic' }, new Set(['name'])),
  );
  pending[0]({ id: '1', name: 'Server' });
  await older;
  expect(client.store.read('User:1')?.name).toBe('Optimistic');
  settle();
  expect(client.store.read('User:1')?.name).toBe('Server');
});

test('orders overlapping by-ID reads independently of the requesting view', async () => {
  const pending: Array<(records: Array<Record<string, unknown>>) => void> = [];
  const client = createClient({
    roots: { viewer: clientRoot<User, 'User'>('User') },
    transport: { fetchById: () => new Promise((resolve) => pending.push(resolve)) },
    types: [{ type: 'User' }],
  });
  const older = client.request({ viewer: { id: '1', view: Profile } });
  const newer = client.request({ viewer: { id: '1', view: Name } });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]([{ id: '1', name: 'New' }]);
  await newer;
  pending[0]([{ bio: 'Bio', id: '1', name: 'Old' }]);
  await older;
  expect(client.store.read('User:1')).toMatchObject({ bio: 'Bio', name: 'New' });
});

test('late requests do not overwrite optimistic mutations after they commit', async () => {
  const { client, pending, start } = setup();
  client.write('User', { id: '1', name: 'Initial' }, new Set(['id', 'name']));
  const older = start();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const settle = client.store.optimisticUpdate(() =>
    client.write('User', { id: '1', name: 'Optimistic' }, new Set(['name'])),
  );
  settle(() => client.write('User', { id: '1', name: 'Confirmed' }, new Set(['name'])));
  pending[0]({ id: '1', name: 'Old' });
  await older;
  expect(client.store.read('User:1')?.name).toBe('Confirmed');
});
