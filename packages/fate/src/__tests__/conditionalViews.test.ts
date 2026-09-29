import { expect, expectTypeOf, test, vi } from 'vite-plus/test';
import { alias } from '../alias.ts';
import { createClient } from '../client.ts';
import { defer } from '../defer.ts';
import { clientRoot } from '../root.ts';
import { getSelectionPlan } from '../selection.ts';
import type { SelectionOf, ViewData } from '../types.ts';
import { view } from '../view.ts';
import { when } from '../when.ts';

type User = { __typename: 'User'; friend: User | null; id: string; name: string };
const Name = view<User>()(({ locale }: { locale: string }) => ({ name: { args: { locale } } }));
const Names = view<User>()(({ enabled }: { enabled: boolean }) => ({
  first: alias(Name({ locale: 'en' })),
  second: when(enabled, alias(Name({ locale: 'ja' }))),
}));
const setup = () => {
  const roots = { user: clientRoot<User, 'User'>('User') };
  const fetchById = vi.fn(async (_type, ids, _select, args) =>
    ids.map((id: string | number) => ({
      __typename: 'User',
      friend: null,
      id,
      name: args?.name?.locale ?? 'Ada',
    })),
  );
  const client = createClient<[typeof roots, Record<never, never>]>({
    roots,
    transport: { fetchById },
    types: [{ fields: { friend: { type: 'User' } }, type: 'User' }],
  });
  return { client, fetchById };
};

test('lowers simultaneous bound named fragments through transports without native aliases', async () => {
  const { client, fetchById } = setup();
  const result = await client.request({ user: { id: '1', view: Names({ enabled: true }) } });
  const data = (
    await client.readView<User, SelectionOf<typeof Names>, typeof Names>(Names, result.user)
  ).data;
  expect((await client.readView(Name, data.first)).data).toMatchObject({ name: 'en' });
  expect((await client.readView(Name, data.second!)).data).toMatchObject({ name: 'ja' });
  expect(fetchById).toHaveBeenCalledTimes(2);
  for (const [, , paths] of fetchById.mock.calls) {
    expect([...paths]).toEqual(['name']);
  }
  const equivalent = await client.request({ user: { id: '1', view: Names({ enabled: true }) } });
  expect(equivalent).toBe(result);
  expect(fetchById).toHaveBeenCalledTimes(2);
});

test('conditional nullable fields distinguish skipped from actual null and omit subscriptions', async () => {
  const { client, fetchById } = setup();
  const Nullable = view<User>()(({ enabled }: { enabled: boolean }) => ({
    friend: when(enabled, Name({ locale: 'en' })),
    name: when(enabled, true),
  }));
  const hidden = await client.readView(
    Nullable,
    client.ref('User', '1', Nullable({ enabled: false })),
  );
  expect(hidden.data).toMatchObject({ friend: undefined, name: undefined });
  expect(hidden.coverage).toEqual([]);
  expect(fetchById).not.toHaveBeenCalled();
  const visible = await client.readView(
    Nullable,
    client.ref('User', '1', Nullable({ enabled: true })),
  );
  expect(visible.data).toMatchObject({ friend: null, name: 'Ada' });
  type Data = ViewData<User, SelectionOf<typeof Nullable>>;
  expectTypeOf<Data['friend']>().toEqualTypeOf<
    import('../types.ts').ViewRef<'User'> | null | undefined
  >();
});

test('bindings survive nested entity refs, spreads, and conditional deferred fields', async () => {
  const { client } = setup();
  const Parent = view<User>()({ friend: Name({ locale: 'ja' }), id: true });
  client.write(
    'User',
    { friend: { __typename: 'User', id: '2' }, id: '1' },
    new Set(['id', 'friend.id']),
  );
  const parent = (
    await client.readView<User, SelectionOf<typeof Parent>, typeof Parent>(
      Parent,
      client.ref('User', '1', Parent),
    )
  ).data;
  expect((await client.readView(Name, parent.friend!)).data).toMatchObject({ name: 'ja' });
  const Deferred = view<User>()({ friend: when(false, defer(Name({ locale: 'en' }))) });
  expect((await client.readView(Deferred, client.ref('User', '1', Deferred))).data).toMatchObject({
    friend: undefined,
  });
});

test('inactive connections do not register live policies or arguments', () => {
  type Group = { __typename: 'Group'; users: Array<User> };
  const Hidden = view<Group>()({
    users: when(false, {
      args: { first: 5 },
      items: { node: Name({ locale: 'en' }) },
      live: { prepend: 'visible' },
    }),
  });
  const plan = getSelectionPlan(Hidden, null);
  expect(plan.paths.size).toBe(0);
  expect(plan.args.size).toBe(0);
  expect(plan.live.size).toBe(0);
});

test('cache-only named refs cannot fetch and do not poison ordinary refs', async () => {
  const { client, fetchById } = setup();
  const request = { user: { id: '1', view: Names({ enabled: true }) } };
  const normal = await client.request(request);
  const cached = client.observeRequest(request, { mode: 'cache-only' }).getSnapshot().data!;
  const read = (ref: typeof normal.user) =>
    client.readView<User, SelectionOf<typeof Names>, typeof Names>(Names, ref);
  const normalData = (await read(normal.user)).data;
  const cachedData = (await read(cached.user)).data;
  client.deleteRecord('User', '1');
  expect(() =>
    client.readView<User, SelectionOf<typeof Name>, typeof Name>(Name, cachedData.first),
  ).toThrow(/Cache-only/);
  expect(fetchById).toHaveBeenCalledTimes(2);
  expect((await client.readView(Name, normalData.first)).data).toMatchObject({ name: 'en' });
  expect(fetchById).toHaveBeenCalledTimes(3);
});

test('named fragment refs preserve the owner identity with a custom entity ID', async () => {
  const SimpleName = view<User>()({ name: true });
  const Parent = view<User>()({ details: alias(SimpleName) });
  const fetchById = vi.fn(async () => []);
  const client = createClient({
    roots: {},
    transport: { fetchById },
    types: [{ getId: (record) => (record as { slug: string }).slug, type: 'User' }],
  });
  client.write('User', { id: 'unrelated-id', name: 'Ada', slug: 'owner' }, new Set(['name']));
  const data = (
    await client.readView<User, SelectionOf<typeof Parent>, typeof Parent>(
      Parent,
      client.ref('User', 'owner', Parent),
    )
  ).data;
  expect(data.details.id).toBe('owner');
  expect((await client.readView(SimpleName, data.details)).data).toMatchObject({ name: 'Ada' });
  expect(fetchById).not.toHaveBeenCalled();
});
