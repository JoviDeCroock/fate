import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildSchema } from 'graphql';
import { expect, test } from 'vite-plus/test';
import { graphqlMutation } from '../../graphqlTransport.ts';
import { dataView } from '../../server/dataView.ts';
import { createClientSource } from '../client.ts';
import { createGraphQLArgumentSchema } from '../graphql.ts';

const execFileAsync = promisify(execFile);
const schema = `
  schema { query: Read, mutation: Write }
  enum Biome { Grassland Desert }
  input Filter { biome: Biome!, limit: Int! = 5, next: Filter, biomes: [Biome!] }
  type Map { id: ID!, name: String!, state(biome: Biome!): String! }
  type Read { map(filter: Filter!): Map, optionalMap(biome: Biome): Map, viewer: Map }
  type Write { edit(input: Filter!): Map, rename(id: ID!, name: String!): Map }
`;
type MapEntity = { __typename: 'Map'; id: string; name: string; state: string };
const mapDataView = dataView<MapEntity>('Map')({ id: true, name: true, state: true });
const moduleExports = {
  fateGraphQL: {
    mutations: {
      edit: graphqlMutation<MapEntity, unknown, MapEntity>('Map', { field: 'edit' }),
      rename: graphqlMutation<MapEntity, unknown, MapEntity>('Map', {
        field: 'rename',
        inputArg: false,
      }),
    },
    roots: { selectedMap: { field: 'map' } },
    schema,
  },
  mapDataView,
  Root: { optionalMap: mapDataView, selectedMap: mapDataView, viewer: mapDataView },
};

test('extracts input defaults and custom root names from SDL and schema objects', () => {
  const metadata = createGraphQLArgumentSchema(schema);
  expect(metadata).toEqual(createGraphQLArgumentSchema(buildSchema(schema)));
  expect(metadata).toMatchObject({
    inputs: {
      Filter: { fields: { limit: { hasDefault: true, type: 'Int!' }, next: { type: 'Filter' } } },
    },
    mutationType: 'Write',
    queryType: 'Read',
  });
  expect(metadata.fields.Read.map.filter.type).toBe('Filter!');
});

test('explains undeclared SDL directives without relaxing schema validation', () => {
  const annotatedSDL = `
    type Query @fetchable(field_name: "id") {
      viewer: String @auth(role: "User")
    }
  `;
  expect(() => createGraphQLArgumentSchema(annotatedSDL)).toThrow(
    /SDL uses undeclared directives @fetchable, @auth.*Declare them.*assumeValidSDL/,
  );
  expect(
    createGraphQLArgumentSchema(buildSchema(annotatedSDL, { assumeValidSDL: true })).queryType,
  ).toBe('Query');
  expect(() => createGraphQLArgumentSchema('type Query { viewer: Missing }')).toThrow(
    /Unknown type "Missing"/,
  );
});

test('rejects schema mappings with unknown fields or mutation inputs during generation', () => {
  const generate = (fateGraphQL: object) =>
    createClientSource({
      moduleExports: { ...moduleExports, fateGraphQL },
      moduleName: './contract.ts',
      transport: 'graphql',
    });
  expect(() =>
    generate({ ...moduleExports.fateGraphQL, roots: { selectedMap: { field: 'typo' } } }),
  ).toThrow(/Unknown query field/);
  expect(() =>
    generate({
      ...moduleExports.fateGraphQL,
      mutations: { edit: { entity: 'Map', field: 'edit', inputArg: 'typo' } },
    }),
  ).toThrow(/Unknown input argument/);
  expect(() =>
    createClientSource({
      moduleExports: {
        ...moduleExports,
        typo: dataView<{ wrong: string }>('Map')({ wrong: true }),
      },
      moduleName: './contract.ts',
      transport: 'graphql',
    }),
  ).toThrow(/Map.wrong/);
});

test.each(['@nkzw/fate', 'react-fate', 'vue-fate'] as const)(
  'generates argument contracts enforced by %s',
  async (clientModule) => {
    const root = process.cwd();
    const directory = await mkdtemp(path.join(root, 'node_modules/.fate-graphql-'));
    try {
      const source = createClientSource({
        clientModule,
        moduleExports,
        moduleName: './contract.ts',
        transport: 'graphql',
      });
      expect(source).toContain('schema: graphQL.schema');
      expect(source).not.toContain('buildSchema');
      await writeFile(path.join(directory, 'client.ts'), source);
      await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(
        path.join(directory, 'contract.ts'),
        `
      import type { GraphQLMutationDefinition } from '@nkzw/fate';
      export type Map = { __typename: 'Map'; id: string; name: string; state: string };
      export declare const fateGraphQL: { mutations: {
        edit: GraphQLMutationDefinition<Map, unknown, Map>;
        rename: GraphQLMutationDefinition<Map, unknown, Map>;
      } };
    `,
      );
      await writeFile(
        path.join(directory, 'usage.ts'),
        `
      import '${clientModule}/client';
      import { view } from '@nkzw/fate';
      import type { Map } from './contract.ts';
      import { createFateClient, type GraphQLFieldArguments } from './client.ts';
      const client = createFateClient({ url: '/graphql' });
      const MapView = view<Map>()({ name: true });
      ${
        clientModule === '@nkzw/fate'
          ? ''
          : `
      import { useRequest } from '${clientModule}';
      useRequest({ selectedMap: { args: { filter: { biome: 'Grassland' } }, view: MapView } });
      // @ts-expect-error Adapter enforces required root arguments.
      useRequest({ selectedMap: { view: MapView } });
      // @ts-expect-error Adapter enforces enum values.
      useRequest({ selectedMap: { args: { filter: { biome: 'Lava' } }, view: MapView } });
      `
      }

      client.request({ selectedMap: { args: { filter: { biome: 'Grassland' } }, view: MapView } });
      client.request({ selectedMap: { args: { filter: { biome: 'Desert', biomes: ['Grassland'], next: null } }, view: MapView } });
      client.request({ viewer: { args: { state: { biome: 'Desert' } }, view: MapView } });
      client.request({ viewer: { view: MapView } });
      client.request({ optionalMap: { view: MapView } });
      client.request({ optionalMap: { args: { biome: 'Grassland' }, view: MapView } });
      // @ts-expect-error Optional arguments still enforce their types.
      client.request({ optionalMap: { args: { biome: 'Lava' }, view: MapView } });
      // @ts-expect-error Root without arguments does not accept arbitrary keys.
      client.request({ viewer: { args: { typo: true }, view: MapView } });
      client.mutations.edit({ input: { biome: 'Grassland' } });
      client.mutations.rename({ input: { id: 'Map-1', name: 'New' } });
      const nested = { biome: 'Grassland' } satisfies GraphQLFieldArguments['Map']['state'];
      void nested;
      // @ts-expect-error Required root argument.
      client.request({ selectedMap: { view: MapView } });
      // @ts-expect-error Unknown enum value.
      client.request({ selectedMap: { args: { filter: { biome: 'Lava' } }, view: MapView } });
      // @ts-expect-error Unknown root argument.
      client.request({ selectedMap: { args: { filter: { biome: 'Grassland' }, typo: true }, view: MapView } });
      // @ts-expect-error Non-null input even when defaulted.
      client.mutations.edit({ input: { biome: 'Grassland', limit: null } });
      // @ts-expect-error Required input-object field.
      client.mutations.edit({ input: {} });
      // @ts-expect-error Mutation arguments come from the schema, not the manual unknown input.
      client.mutations.rename({ input: { id: 'Map-1' } });
      // @ts-expect-error Nested enum input.
      client.mutations.edit({ input: { biome: 'Grassland', biomes: ['Lava'] } });
      // @ts-expect-error Field argument enum.
      const bad = { biome: 'Lava' } satisfies GraphQLFieldArguments['Map']['state'];
      void bad;
    `,
      );
      await writeFile(
        path.join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            allowImportingTsExtensions: true,
            jsx: 'react-jsx',
            module: 'nodenext',
            noEmit: true,
            noUnusedLocals: true,
            paths: {
              '@nkzw/fate': [path.join(root, 'packages/fate/src/index.ts')],
              '@nkzw/fate/client': [path.join(root, 'packages/fate/lib/clientStub.d.mts')],
              'react-fate': [path.join(root, 'packages/react-fate/src/index.tsx')],
              'react-fate/client': [path.join(root, 'packages/react-fate/lib/client.d.mts')],
              'vue-fate': [path.join(root, 'packages/vue-fate/src/index.ts')],
              'vue-fate/client': [path.join(root, 'packages/vue-fate/lib/client.d.mts')],
            },
            skipLibCheck: true,
            strict: true,
            target: 'esnext',
            types: ['vite/client'],
          },
          include: ['./*.ts'],
        }),
      );
      const result = await execFileAsync(process.execPath, [
        path.join(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        path.join(directory, 'tsconfig.json'),
      ]).catch((error: Error & { stdout: string }) => {
        throw new Error(error.stdout || error.message, { cause: error });
      });
      expect(result.stdout).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
