import { buildSchema, graphql, parse, validate } from 'graphql';
import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { createClient } from '../client.ts';
import { createGraphQLArgumentSchema } from '../codegen/graphql.ts';
import { createGraphQLTransport } from '../graphqlTransport.ts';
import { valueMutation } from '../mutation.ts';
import { clientValueRoot } from '../root.ts';

const graphQLSSE = vi.hoisted(() => ({
  createClient: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('graphql-sse', () => ({
  createClient: graphQLSSE.createClient,
}));

const jsonResponse = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  });

const getRequestBody = (fetch: ReturnType<typeof vi.fn>) => {
  const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as { query: string };
};

beforeEach(() => {
  graphQLSSE.createClient.mockReset();
  graphQLSSE.subscribe.mockReset();
  graphQLSSE.createClient.mockReturnValue({ subscribe: graphQLSSE.subscribe });
  graphQLSSE.subscribe.mockReturnValue(vi.fn());
});

test('fetches and caches scalar query roots without entity identities', async () => {
  const fetch = vi.fn(async () => jsonResponse({ data: { f1: false, f2: '', f3: 0 } }));
  const transport = createGraphQLTransport({
    fetch,
    live: false,
    roots: {
      origin: { field: 'origin', type: 'Boolean' },
      replay: { field: 'fetchReplay', type: 'String' },
      stars: { field: 'stars', type: 'Int' },
    },
    types: [],
    url: '/graphql',
  });
  const roots = {
    origin: clientValueRoot<boolean>(),
    replay: clientValueRoot<string>(),
    stars: clientValueRoot<number>(),
  };
  const client = createClient({ roots, transport, types: [] });
  const request = {
    origin: { value: true },
    replay: { value: true },
    stars: { value: true },
  } as const;

  await expect(client.request(request)).resolves.toEqual({ origin: false, replay: '', stars: 0 });
  await expect(client.request(request)).resolves.toEqual({ origin: false, replay: '', stars: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const restored = createClient({ roots, transport, types: [] });
  restored.hydrate(client.dehydrate());
  await expect(restored.request(request)).resolves.toEqual({ origin: false, replay: '', stars: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const query = getRequestBody(fetch).query;
  expect(query).toContain('origin');
  expect(query).not.toContain('origin {');
  expect(query).not.toContain('stars {');
  expect(query).not.toContain('fetchReplay {');
});

test('returns scalar mutation results without requiring an entity record', async () => {
  const fetch = vi.fn(async () => jsonResponse({ data: { f1: false } }));
  const transport = createGraphQLTransport<{ endGame: { input: { id: string }; output: boolean } }>(
    {
      fetch,
      live: false,
      mutations: { endGame: { entity: '__value__', field: 'endGame', inputArg: false } },
      types: [],
      url: '/graphql',
    },
  );
  const mutations = { endGame: valueMutation<{ id: string }, boolean>() };
  const roots = {};
  const client = createClient<[typeof roots, typeof mutations]>({
    mutations,
    roots,
    transport,
    types: [],
  });

  await expect(client.mutations.endGame({ input: { id: 'Game-1' } })).resolves.toEqual({
    error: undefined,
    result: false,
  });
  expect(getRequestBody(fetch).query).toContain('endGame(id: "Game-1")');
  expect(getRequestBody(fetch).query).not.toContain('endGame(id: "Game-1") {');
});

test('selects embedded objects without requesting entity identity fields', async () => {
  const schema = buildSchema(
    `type Query { viewer: User } type User { id: ID! character: CharacterImage } type CharacterImage { color: String! url: String! }`,
  );
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: {
          __typename: 'User',
          character: { color: 'blue', url: '/character.png' },
          id: 'User-1',
        },
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    live: false,
    roots: { viewer: { type: 'User' } },
    types: [
      { fields: { character: { embedded: 'CharacterImage' } }, type: 'User' },
      { type: 'CharacterImage' },
    ],
    url: '/graphql',
  });

  await expect(
    transport.fetchQuery?.('viewer', new Set(['character.color', 'character.url'])),
  ).resolves.toMatchObject({
    character: { color: 'blue', url: '/character.png' },
  });
  const query = getRequestBody(fetch).query;
  expect(validate(schema, parse(query))).toEqual([]);
  expect(query).toContain('character { color url }');
});

test('fetches and caches ID-less object query roots with nested selections', async () => {
  const schema = buildSchema(
    `type Query { prices(locale: String!): Price } type Price { amount: Int! currency: String! details: PriceDetails } type PriceDetails { label: String! }`,
  );
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: {
          amount: 42,
          currency: 'USD',
          details: { label: 'Standard' },
        },
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    live: false,
    roots: { prices: { embedded: true, type: 'Price' } },
    schema: createGraphQLArgumentSchema(schema),
    types: [
      { fields: { details: { embedded: 'PriceDetails' } }, type: 'Price' },
      { type: 'PriceDetails' },
    ],
    url: '/graphql',
  });
  const roots = {
    prices: clientValueRoot<
      { amount: number; currency: string; details: { label: string } },
      { locale: string }
    >(),
  };
  const client = createClient({ roots, transport, types: [] });
  const request = {
    prices: {
      args: { locale: 'en' },
      value: { amount: true, currency: true, details: { label: true } },
    },
  } as const;

  await expect(client.request(request)).resolves.toEqual({
    prices: {
      amount: 42,
      currency: 'USD',
      details: { label: 'Standard' },
    },
  });
  await client.request(request);
  expect(fetch).toHaveBeenCalledTimes(1);
  const query = getRequestBody(fetch).query;
  expect(validate(schema, parse(query))).toEqual([]);
  expect(query).toContain('details { label }');
  const restored = createClient({ roots, transport, types: [] });
  restored.hydrate(client.dehydrate());
  await expect(restored.request(request)).resolves.toEqual({
    prices: {
      amount: 42,
      currency: 'USD',
      details: { label: 'Standard' },
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('fetches nodes through the Relay nodes field and decodes global ids', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: [
          {
            __typename: 'Post',
            author: { __typename: 'User', id: 'User-u1', name: 'Ada' },
            id: 'Post-p1',
            title: 'One',
          },
        ],
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    types: [
      {
        fields: {
          author: { type: 'User' },
        },
        type: 'Post',
      },
      { type: 'User' },
    ],
    url: '/graphql',
  });

  await expect(
    transport.fetchById('Post', ['p1'], new Set(['id', 'title', 'author.id', 'author.name'])),
  ).resolves.toEqual([
    {
      __typename: 'Post',
      author: { __typename: 'User', id: 'u1', name: 'Ada' },
      id: 'p1',
      title: 'One',
    },
  ]);

  expect(fetch).toHaveBeenCalledTimes(1);
  const body = getRequestBody(fetch);
  expect(body.query).toContain('nodes(ids: ["Post-p1"])');
  expect(body.query).toContain('... on Post');
  expect(body.query).toContain('author { __typename id name }');
});

test('maps Relay connections to Fate list payloads', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: {
          edges: [
            {
              cursor: 'cursor-1',
              node: { __typename: 'Post', id: 'Post-p1', title: 'One' },
            },
          ],
          pageInfo: {
            endCursor: 'cursor-1',
            hasNextPage: true,
            hasPreviousPage: false,
            startCursor: 'cursor-1',
          },
        },
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    roots: {
      posts: { type: 'Post' },
    },
    types: [{ type: 'Post' }],
    url: '/graphql',
  });

  await expect(
    transport.fetchList?.('posts', new Set(['id', 'title']), { first: 1 }),
  ).resolves.toEqual({
    items: [
      {
        cursor: 'cursor-1',
        node: { __typename: 'Post', id: 'p1', title: 'One' },
      },
    ],
    pagination: {
      hasNext: true,
      hasPrevious: false,
      nextCursor: 'cursor-1',
      previousCursor: 'cursor-1',
    },
  });

  const body = getRequestBody(fetch);
  expect(body.query).toContain('posts(first: 1)');
  expect(body.query).toContain('edges { cursor node');
  expect(body.query).toContain('pageInfo { endCursor hasNextPage hasPreviousPage startCursor }');
});

test('keeps nested selection args off root GraphQL fields', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: {
          edges: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
          },
        },
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    roots: {
      posts: { type: 'Post' },
    },
    types: [
      {
        fields: {
          comments: { listOf: 'Comment' },
        },
        type: 'Post',
      },
      { type: 'Comment' },
    ],
    url: '/graphql',
  });

  await transport.fetchList?.('posts', new Set(['id', 'comments.id']), {
    comments: { first: 3 },
    first: 10,
  });

  const body = getRequestBody(fetch);
  expect(body.query).toContain('posts(first: 10)');
  expect(body.query).not.toContain('posts(first: 10, comments:');
  expect(body.query).toContain('comments(first: 3)');
});

test('omits empty GraphQL argument lists after filtering undefined values', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: {
          edges: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
          },
        },
      },
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    roots: {
      posts: { type: 'Post' },
    },
    types: [
      {
        fields: {
          comments: { listOf: 'Comment' },
        },
        type: 'Post',
      },
      { type: 'Comment' },
    ],
    url: '/graphql',
  });

  await transport.fetchList?.('posts', new Set(['id', 'comments.id']), {
    comments: { first: undefined },
    first: undefined,
  });

  const body = getRequestBody(fetch);
  expect(body.query).toContain('posts {');
  expect(body.query).toContain('comments {');
  expect(body.query).not.toContain('posts()');
  expect(body.query).not.toContain('comments()');
});

test('rejects only operations matching aliased GraphQL errors', async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: {
        f1: { __typename: 'User', id: 'User-u1', name: 'Ada' },
        f2: null,
      },
      errors: [{ message: 'Viewer failed', path: ['f2'] }],
    }),
  );
  const transport = createGraphQLTransport({
    fetch,
    roots: {
      brokenViewer: { field: 'viewer', type: 'User' },
      viewer: { type: 'User' },
    },
    types: [{ type: 'User' }],
    url: '/graphql',
  });

  const viewer = transport.fetchQuery!('viewer', new Set(['id', 'name']));
  const brokenViewer = transport.fetchQuery!('brokenViewer', new Set(['id', 'name']));

  await expect(viewer).resolves.toEqual({ __typename: 'User', id: 'u1', name: 'Ada' });
  await expect(brokenViewer).rejects.toThrow('Viewer failed');

  expect(fetch).toHaveBeenCalledTimes(1);
});

test('multiplexes live GraphQL subscriptions over one SSE client', async () => {
  const sinks: Array<{
    next(result: { data?: Record<string, unknown> }): void;
  }> = [];
  const unsubscribeNode = vi.fn();
  const unsubscribeConnection = vi.fn();
  graphQLSSE.subscribe
    .mockImplementationOnce((_request, sink) => {
      sinks.push(sink);
      return unsubscribeNode;
    })
    .mockImplementationOnce((_request, sink) => {
      sinks.push(sink);
      return unsubscribeConnection;
    });

  const transport = createGraphQLTransport({
    types: [{ type: 'Post' }],
    url: 'http://local/graphql',
  });
  const onData = vi.fn();
  const onEvent = vi.fn();
  const unsubscribeNodeResult = transport.subscribeById?.(
    'Post',
    'p1',
    new Set(['id', 'title']),
    undefined,
    {
      onData,
    },
  );
  const unsubscribeConnectionResult = transport.subscribeConnection?.(
    'posts',
    'Post',
    undefined,
    new Set(['id', 'title']),
    undefined,
    {
      onEvent,
    },
  );

  await vi.waitFor(() => expect(graphQLSSE.subscribe).toHaveBeenCalledTimes(2));

  expect(graphQLSSE.createClient).toHaveBeenCalledTimes(1);
  expect(graphQLSSE.createClient).toHaveBeenCalledWith(
    expect.objectContaining({
      credentials: 'include',
      lazy: true,
      singleConnection: true,
      url: 'http://local/graphql/stream',
    }),
  );
  expect(graphQLSSE.subscribe.mock.calls[0]?.[0].query).toContain('subscription FateLiveNode');
  expect(graphQLSSE.subscribe.mock.calls[1]?.[0].query).toContain(
    'subscription FateLiveConnection',
  );

  sinks[0]?.next({
    data: {
      fateLiveNode: {
        data: { __typename: 'Post', id: 'Post-p1', title: 'Updated' },
        select: ['title'],
      },
    },
  });

  expect(onData).toHaveBeenCalledWith({ __typename: 'Post', id: 'p1', title: 'Updated' }, [
    'title',
  ]);

  sinks[1]?.next({
    data: {
      fateLiveConnection: {
        cursor: 'cursor-2',
        node: { __typename: 'Post', id: 'Post-p2', title: 'Second' },
        nodeType: 'Post',
        type: 'appendEdge',
      },
    },
  });

  expect(onEvent).toHaveBeenCalledWith({
    edge: {
      cursor: 'cursor-2',
      node: { __typename: 'Post', id: 'p2', title: 'Second' },
    },
    nodeType: 'Post',
    targetCursor: undefined,
    type: 'appendEdge',
  });

  unsubscribeNodeResult?.();
  unsubscribeConnectionResult?.();
  expect(unsubscribeNode).toHaveBeenCalledTimes(1);
  expect(unsubscribeConnection).toHaveBeenCalledTimes(1);
});

test('executes enum arguments as schema-typed variables', async () => {
  const schema = buildSchema(`
    enum Biome { Grassland Desert }
    type Map { id: ID!, name: String! }
    type Query { map(biome: Biome!): Map! }
  `);
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return jsonResponse(
      await graphql({
        rootValue: { map: ({ biome }: { biome: string }) => ({ id: 'Map-1', name: biome }) },
        schema,
        source: body.query,
        variableValues: body.variables,
      }),
    );
  });
  const transport = createGraphQLTransport({
    fetch,
    roots: { map: { type: 'Map' } },
    schema: createGraphQLArgumentSchema(schema),
    types: [{ type: 'Map' }],
    url: '/graphql',
  });

  await expect(
    transport.fetchQuery?.('map', new Set(['name']), { biome: 'Grassland' }),
  ).resolves.toMatchObject({ id: '1', name: 'Grassland' });
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body.query).toMatch(/\$\w+: Biome!/);
  expect(body.query).not.toContain('Grassland');
  expect(Object.values(body.variables)).toEqual(['Grassland']);
});

const argumentSDL = `
  enum Biome { Grassland Desert }
  input Filter { biome: Biome!, biomes: [Biome!], limit: Int! = 4, next: Filter }
  type Map implements Node { id: ID!, name: String!, related(biome: Biome!): Map!, state(biome: Biome!): String! }
  interface Node { id: ID! }
  type Edge { cursor: String!, node: Map! }
  type PageInfo { endCursor: String, startCursor: String, hasNextPage: Boolean!, hasPreviousPage: Boolean! }
  type Connection { edges: [Edge!]!, pageInfo: PageInfo! }
  type Query { maps(filter: Filter!, first: Int = 2): Connection!, map(biome: Biome!): Map!, nodes(ids: [ID!]!): [Node]! }
  type Mutation { update(input: Filter!): Map!, edit(biome: Biome!): Map! }
`;

const pageInfo = { hasNextPage: false, hasPreviousPage: false };

const resolveMap = ({ biome }: { biome: string }) => ({
  id: 'Map-1',
  name: biome,
  related: ({ biome }: { biome: string }) => resolveMap({ biome }),
  state: ({ biome }: { biome: string }) => biome,
});

const createArgumentTransport = () => {
  const schema = buildSchema(argumentSDL);
  const maps = vi.fn(({ filter }: { filter: { biome: string } }) => ({
    edges: [{ cursor: 'one', node: resolveMap(filter) }],
    pageInfo,
  }));
  const update = vi.fn(({ input }: { input: { biome: string } }) => resolveMap(input));
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    return jsonResponse(
      await graphql({
        rootValue: { edit: resolveMap, map: resolveMap, maps, nodes: () => [], update },
        schema,
        source: query,
        variableValues: variables,
      }),
    );
  });
  const transport = createGraphQLTransport<{
    edit: { input: { args?: object; biome: string }; output: unknown };
    update: { input: { args?: object; biome: string }; output: unknown };
  }>({
    fetch,
    mutations: {
      edit: { entity: 'Map', field: 'edit', inputArg: false },
      update: { entity: 'Map', field: 'update' },
    },
    roots: { map: { type: 'Map' }, maps: { type: 'Map' } },
    schema: createGraphQLArgumentSchema(schema),
    types: [{ fields: { related: { type: 'Map' } }, type: 'Map' }],
    url: '/graphql',
  });
  return { fetch, maps, transport, update };
};

test('batches independent variables and preserves input defaults and explicit nulls', async () => {
  const { fetch, maps, transport } = createArgumentTransport();
  const [list, map] = await Promise.all([
    transport.fetchList?.('maps', new Set(['name', 'state']), {
      filter: { biome: 'Grassland', biomes: ['Grassland', 'Desert'], limit: undefined, next: null },
      first: undefined,
      state: { biome: 'Desert' },
    }),
    transport.fetchQuery?.('map', new Set(['name']), { biome: 'Desert' }),
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(list?.items[0].node).toMatchObject({ name: 'Grassland', state: 'Desert' });
  expect(map).toMatchObject({ name: 'Desert' });
  expect(maps.mock.calls[0][0]).toMatchObject({
    filter: { biome: 'Grassland', biomes: ['Grassland', 'Desert'], limit: 4, next: null },
    first: 2,
  });
  const { query, variables } = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(query).toContain('Filter!');
  expect(query).not.toContain('Grassland');
  expect(Object.values(variables)).toContainEqual({
    biome: 'Grassland',
    biomes: ['Grassland', 'Desert'],
    next: null,
  });
});

test('keeps query and mutation variables separate and strips mutation selection metadata', async () => {
  const { fetch, transport, update } = createArgumentTransport();
  const results = await Promise.all([
    transport.fetchQuery?.('map', new Set(['name']), { biome: 'Desert' }),
    transport.mutate?.(
      'update',
      { args: { state: { biome: 'Desert' } }, biome: 'Grassland' },
      new Set(['name', 'state']),
    ),
    transport.mutate?.('edit', { biome: 'Desert' }, new Set(['name'])),
  ]);
  expect(results).toMatchObject([
    { name: 'Desert' },
    { name: 'Grassland', state: 'Desert' },
    { name: 'Desert' },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[0][0]).toEqual({ input: { biome: 'Grassland', limit: 4 } });
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(Object.keys(bodies[0].variables)).toHaveLength(1);
  expect(Object.keys(bodies[1].variables)).toHaveLength(3);
});

test.each([
  [{ filter: { biome: 'Lava' } }, /filter.biome/],
  [{ filter: { biome: 'Grassland', typo: true } }, /filter.typo/],
  [{ filter: { biome: 'Grassland', biomes: [null] } }, /biomes\[0\]/],
  [{ filter: { biome: 'Grassland', limit: null } }, /filter.limit/],
  [{ filter: { biome: 'Grassland', limit: 1.5 } }, /filter.limit/],
  [{ filter: { biome: 'Grassland', next: { biome: 'Lava' } } }, /next.biome/],
  [{}, /maps.filter/],
  [{ filter: null }, /maps.filter/],
  [{ filter: { biome: 'Grassland' }, typo: 1 }, /maps.typo/],
] as const)('rejects invalid schema arguments before sending a request: %j', (args, error) => {
  const { fetch, transport } = createArgumentTransport();
  expect(() => transport.fetchList?.('maps', new Set(['name']), args)).toThrow(error);
  expect(fetch).not.toHaveBeenCalled();
});

test('validates selected fields and required nested arguments', () => {
  const { fetch, transport } = createArgumentTransport();
  expect(() => transport.fetchQuery?.('map', new Set(['state']), { biome: 'Grassland' })).toThrow(
    /Map.state.biome/,
  );
  expect(() => transport.fetchQuery?.('map', new Set(['typo']), { biome: 'Grassland' })).toThrow(
    /Map.typo/,
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('declares node IDs using the schema variable type', async () => {
  const { fetch, transport } = createArgumentTransport();
  await expect(transport.fetchById('Map', ['1'], new Set(['name']))).resolves.toEqual([]);
  const { query, variables } = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(query).toMatch(/\$\w+: \[ID!\]!/);
  expect(Object.values(variables)).toEqual([['Map-1']]);
});

test('separates arguments at every nested selection level', async () => {
  const { transport } = createArgumentTransport();
  await expect(
    transport.fetchQuery?.('map', new Set(['related.name', 'related.state']), {
      biome: 'Grassland',
      related: { biome: 'Desert', state: { biome: 'Grassland' } },
    }),
  ).resolves.toMatchObject({ related: { name: 'Desert', state: 'Grassland' } });
});
