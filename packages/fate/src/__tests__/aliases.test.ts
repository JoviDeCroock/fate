import { buildSchema, graphql } from 'graphql';
import { expect, expectTypeOf, test, vi } from 'vite-plus/test';
import { withAliasSupport } from '../alias-transport.ts';
import { alias } from '../alias.ts';
import { createClient } from '../client.ts';
import { createGraphQLArgumentSchema } from '../codegen/graphql.ts';
import { createGraphQLTransport, graphqlMutation } from '../graphqlTransport.ts';
import { mutation } from '../mutation.ts';
import { createPersistence } from '../persistence.ts';
import { clientRoot } from '../root.ts';
import { getSelectionPlan } from '../selection.ts';
import type { Transport } from '../transport.ts';
import {
  ConnectionTag,
  type ConnectionMetadata,
  type SelectionOf,
  type ViewData,
} from '../types.ts';
import { view } from '../view.ts';
import { memoryStorage } from './persistenceStorage.ts';

type Game = { __typename: 'Game'; id: string; name: string };
type User = { __typename: 'User'; games: Array<Game> | null; id: string; name: string };
const selection = (status: string) => ({
  args: { first: 1, status },
  items: { node: { id: true as const, name: true as const } },
  pagination: { hasNext: true as const, nextCursor: true as const },
});
const Games = view<User>()({
  active: alias('games', selection('Active')),
  lost: alias('games', selection('Lost')),
  title: alias('name', true),
  waiting: alias('games', selection('Waiting')),
});
const schema = buildSchema(`
  enum Status { Active Waiting Lost }
  type Query { viewer: User user(id: ID!): User }
  type Mutation { rename(name: String!): User }
  type User { id: ID! name: String! games(status: Status!, first: Int!, after: String): Connection }
  type Game { id: ID! name: String! }
  type Connection { edges: [Edge!]! pageInfo: PageInfo! }
  type Edge { cursor: String! node: Game! }
  type PageInfo { endCursor: String startCursor: String hasNextPage: Boolean! hasPreviousPage: Boolean! }
`);
const setup = (persistence?: ReturnType<typeof createPersistence>) => {
  const games = vi.fn(({ after, status }: { after?: string; status: string }) =>
    status === 'Lost'
      ? null
      : {
          edges: [
            {
              cursor: after ? '2' : '1',
              node: { id: `${status}-${after ? '2' : '1'}`, name: status },
            },
          ],
          pageInfo: { endCursor: after ? '2' : '1', hasNextPage: !after, hasPreviousPage: false },
        },
  );
  const user = { games, id: '1', name: 'Ada' };
  const rename = vi.fn(({ name }: { name: string }) => ({ ...user, name }));
  const mutations = { rename: mutation<User, { name: string }, User>('User') };
  const graphqlMutations = {
    rename: graphqlMutation<User, { name: string }, User>('User', {
      field: 'rename',
      inputArg: false,
    }),
  };
  const roots = { viewer: clientRoot<User, 'User'>('User') };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify(
        await graphql({
          rootValue: { rename, user: () => user, viewer: () => user },
          schema,
          source: query,
          variableValues: variables,
        }),
      ),
    );
  });
  const types = [{ fields: { games: { listOf: 'Game' } }, type: 'User' }, { type: 'Game' }];
  const client = createClient<[typeof roots, typeof mutations]>({
    mutations,
    persistence,
    roots,
    transport: createGraphQLTransport({
      byId: { User: { field: 'user' } },
      decodeNodeId: (_type, id) => id,
      encodeNodeId: (_type, id) => id,
      fetch,
      live: false,
      mutations: graphqlMutations,
      roots: { viewer: { type: 'User' } },
      schema: createGraphQLArgumentSchema(schema),
      types,
      url: '/graphql',
    }),
    types,
  });
  const read = async () =>
    (
      await client.readView<User, SelectionOf<typeof Games>, typeof Games>(
        Games,
        client.ref('User', '1', Games),
      )
    ).data;
  return { client, fetch, games, read, rename };
};

test('fetches aliased nullable connections together with independent arguments and typed results', async () => {
  const { client, fetch, games, read } = setup();
  await client.request({ viewer: { view: Games } });
  const data = await read();
  expect(data).toMatchObject({
    active: { items: [{ node: { name: 'Active' } }] },
    lost: null,
    title: 'Ada',
    waiting: { items: [{ node: { name: 'Waiting' } }] },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(games).toHaveBeenCalledTimes(3);
  expectTypeOf<ViewData<User, SelectionOf<typeof Games>>['title']>().toEqualTypeOf<string>();
  const plan = getSelectionPlan(Games, null);
  expect(plan.paths).toContain('active:games.name');
});

test('aliases share normalized identity with an ordinary selection and paginate independently', async () => {
  const { client, fetch, read } = setup();
  await client.request({ viewer: { view: Games } });
  const ordinary = view<User>()({ games: selection('Active'), name: true });
  const initial = await client.readView(ordinary, client.ref('User', '1', ordinary));
  expect(initial.data).toMatchObject({
    games: { items: [{ node: { name: 'Active' } }] },
    name: 'Ada',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const data = await read();
  await client.loadConnection(
    view<Game>()({ id: true, name: true }),
    (data.active as unknown as { [ConnectionTag]: ConnectionMetadata })[ConnectionTag],
    { after: '1', first: 1 },
  );
  expect(await read()).toMatchObject({
    active: { items: [{ node: { id: 'Active-1' } }, { node: { id: 'Active-2' } }] },
    lost: null,
    waiting: { items: [{ node: { id: 'Waiting-1' } }] },
  });
});

test('validates alias source fields and their selections', () => {
  // @ts-expect-error Unknown source field.
  view<User>()({ bad: alias('missing', true) });
  // @ts-expect-error A scalar does not accept an object selection.
  view<User>()({ bad: alias('name', { id: true }) });
  // @ts-expect-error Ordinary typos still fail validation.
  view<User>()({ misspelled: true });
});

test('aliases scalar arguments and shares updates across differently named selections', async () => {
  type MapData = { __typename: 'Map'; id: string; state: string };
  const Editor = view<MapData>()({
    draft: alias('state', { args: { editor: true } }),
    published: alias('state', true),
  });
  const Same = view<MapData>()({ state: { args: { editor: true } } });
  const client = createClient({
    roots: {},
    transport: { fetchById: vi.fn() },
    types: [{ type: 'Map' }],
  });
  const plan = getSelectionPlan(Editor, null);
  client.write(
    'Map',
    { 'draft:state': 'Draft', id: '1', 'published:state': 'Published' },
    plan.paths,
    plan,
  );
  expect((await client.readView(Editor, client.ref('Map', '1', Editor))).data).toMatchObject({
    draft: 'Draft',
    published: 'Published',
  });
  const samePlan = getSelectionPlan(Same, null);
  client.write('Map', { id: '1', state: 'Updated' }, samePlan.paths, samePlan);
  expect((await client.readView(Editor, client.ref('Map', '1', Editor))).data).toMatchObject({
    draft: 'Updated',
    published: 'Published',
  });
});

test('rejects incompatible response names and arguments in composed views', () => {
  const first = view<User>()({ renamed: alias('name', true) });
  const second = view<User>()({ renamed: alias('id', true) });
  expect(() => getSelectionPlan({ ...first, ...second }, null)).toThrow(/conflict/i);
  const active = view<User>()({ games: selection('Active') });
  const waiting = view<User>()({ games: selection('Waiting') });
  expect(() => getSelectionPlan({ ...active, ...waiting }, null)).toThrow(/conflict/i);
});

test('lowers aliased reads for transports that only understand schema field names', async () => {
  const fetchById = vi.fn(
    async (
      _type: string,
      ids: Array<string | number>,
      select: Iterable<string>,
      args?: Record<string, unknown>,
    ) => {
      expect([...select].every((path) => !path.includes(':'))).toBe(true);
      const status = (args?.games as { status: string } | undefined)?.status;
      return ids.map((id) => ({
        games:
          status === 'Lost'
            ? null
            : { items: [{ node: { id: status, name: status } }], pagination: { hasNext: false } },
        id,
        name: 'Ada',
      }));
    },
  );
  const client = createClient({
    roots: {},
    transport: { fetchById },
    types: [{ fields: { games: { listOf: 'Game' } }, type: 'User' }, { type: 'Game' }],
  });
  const data = (await client.readView(Games, client.ref('User', '1', Games))).data;
  expect(data).toMatchObject({
    active: { items: [{ node: { name: 'Active' } }] },
    lost: null,
    title: 'Ada',
    waiting: { items: [{ node: { name: 'Waiting' } }] },
  });
});

test('supports root aliases without changing root cache identity', async () => {
  const { client, fetch } = setup();
  const Name = view<User>()({ name: true });
  const result = await client.request({ currentUser: alias('viewer', { view: Name }) });
  expect(result).toMatchObject({ currentUser: { id: '1' } });
  const ordinary = await client.request({ viewer: { view: Name } });
  expect(ordinary).toMatchObject({ viewer: { id: '1' } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('preserves aliases through hydration and cache-only observation', async () => {
  const { client } = setup();
  await client.request({ viewer: { view: Games } });
  const restored = setup();
  restored.client.hydrate(structuredClone(client.dehydrate()));
  const observer = restored.client.observeRequest(
    { viewer: { id: '1', view: Games } },
    { mode: 'cache-only' },
  );
  const unsubscribe = observer.subscribe(() => {});
  expect(observer.getSnapshot().status).toBe('ready');
  expect(await restored.read()).toMatchObject({
    active: { items: [{ node: { id: 'Active-1' } }] },
    lost: null,
  });
  expect(restored.fetch).not.toHaveBeenCalled();
  unsubscribe();
});

test('normalizes alias fields within embedded objects', async () => {
  type Owner = { __typename: 'Owner'; id: string; settings: { title: string } };
  const Settings = view<Owner>()({ settings: { heading: alias('title', true) } });
  const client = createClient({
    roots: {},
    transport: { fetchById: vi.fn() },
    types: [
      { fields: { settings: { embedded: 'Settings' } }, type: 'Owner' },
      { fields: { title: 'scalar' as const }, type: 'Settings' },
    ],
  });
  const plan = getSelectionPlan(Settings, null);
  client.write('Owner', { id: '1', settings: { 'heading:title': 'Hello' } }, plan.paths, plan);
  expect((await client.readView(Settings, client.ref('Owner', '1', Settings))).data).toMatchObject({
    settings: { heading: 'Hello' },
  });
});

test('executes a GraphQL mutation once with multiple aliased argument variants', async () => {
  const { client, read, rename } = setup();
  await client.mutations.rename({ input: { name: 'Grace' }, view: Games });
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await read()).toMatchObject({
    active: { items: [{ node: { name: 'Active' } }] },
    lost: null,
    title: 'Grace',
  });
});

test('rejects unsupported multi-variant native mutations before executing them', async () => {
  const mutate = vi.fn(async () => ({ id: '1' }));
  const transport = withAliasSupport({ fetchById: vi.fn(), mutate } as Transport<any>);
  await expect(transport.mutate!('edit', {}, getSelectionPlan(Games, null).paths)).rejects.toThrow(
    /native alias support/,
  );
  expect(mutate).not.toHaveBeenCalled();
});

test('lowers native live selection paths and projects updates back onto their aliases', () => {
  const unsubscribe = vi.fn();
  const subscribeById = vi.fn<NonNullable<Transport['subscribeById']>>(
    (_type, _id, select, _args, handlers) => {
      expect([...select]).toEqual(['name']);
      handlers.onData({ id: '1', name: 'Grace' }, ['name']);
      return unsubscribe;
    },
  );
  const transport = withAliasSupport({ fetchById: vi.fn(), subscribeById });
  const onData = vi.fn();
  const dispose = transport.subscribeById!('User', '1', ['label:name'], undefined, { onData });
  expect(onData).toHaveBeenCalledWith({ id: '1', 'label:name': 'Grace' }, ['label:name']);
  dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('retains scalar result types with aliased arguments and rejects nested alias typos', () => {
  const Scalar = view<User>()({ title: alias('name', { args: { locale: 'en' } }) });
  expectTypeOf<ViewData<User, SelectionOf<typeof Scalar>>['title']>().toEqualTypeOf<string>();
  // @ts-expect-error Unknown alias source in a nested selection.
  view<User>()({ games: { bad: alias('missing', true) } });
  // @ts-expect-error Invalid scalar subselection under an alias.
  view<User>()({ games: { bad: alias('name', { id: true }) } });
});

test('restores aliased connection records and pagination from persistence without fetching', async () => {
  const storage = memoryStorage();
  const persistence = () => createPersistence({ key: 'aliases', online: () => false, storage });
  const first = setup(persistence());
  try {
    await first.client.request({ viewer: { view: Games } });
    await first.client.persistence!.flush();
  } finally {
    first.client.persistence!.dispose();
  }
  const restored = setup(persistence());
  restored.fetch.mockRejectedValue(new Error('Offline'));
  try {
    await restored.client.request({ viewer: { view: Games } });
    expect(await restored.read()).toMatchObject({
      active: {
        items: [{ node: { id: 'Active-1' } }],
        pagination: { hasNext: true, nextCursor: '1' },
      },
      lost: null,
      waiting: { items: [{ node: { id: 'Waiting-1' } }] },
    });
    expect(restored.fetch).not.toHaveBeenCalled();
  } finally {
    restored.client.persistence!.dispose();
  }
});
