import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

const fixture = mkdtempSync(`${tmpdir()}/fate-optional-peer-`);

beforeAll(() => {
  // Resolve from an isolated checkout so workspace GraphQL peers cannot hide regressions.
  cpSync(new URL('../', import.meta.url), `${fixture}/src`, {
    filter: (path) => !path.includes('/__tests__'),
    recursive: true,
  });
});

afterAll(() => rmSync(fixture, { force: true, recursive: true }));

test('bundles the native client from the public barrel without GraphQL peers', async () => {
  const result = await build({
    bundle: true,
    external: ['@trpc/server/http'],
    format: 'esm',
    logLevel: 'silent',
    platform: 'browser',
    stdin: {
      contents: "export { createClient, createHTTPTransport } from './src/index.ts';",
      resolveDir: fixture,
    },
    write: false,
  });

  expect(result.outputFiles[0].text).not.toContain('graphql-sse');
});

test('bundles GraphQL HTTP queries and reports the missing peer only for live queries', async () => {
  await build({
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    outfile: `${fixture}/graphql.mjs`,
    platform: 'browser',
    stdin: {
      contents: "export { createGraphQLTransport } from './src/graphqlTransport.ts';",
      resolveDir: fixture,
    },
  });

  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { createGraphQLTransport } from './graphql.mjs';

        const http = createGraphQLTransport({
          fetch: async () => Response.json({ data: { f1: { id: 'User-1', name: 'Ada' } } }),
          live: false,
          roots: { viewer: { type: 'User' } },
          types: [{ type: 'User' }],
          url: 'http://local/graphql',
        });
        assert.equal((await http.fetchQuery('viewer', new Set(['name']))).name, 'Ada');

        const live = createGraphQLTransport({ types: [{ type: 'User' }], url: 'http://local/graphql' });
        const error = await new Promise((resolve) => {
          live.subscribeById('User', '1', new Set(['name']), undefined, {
            onData() {},
            onError: resolve,
          });
        });
        assert.equal(error.message,
          "fate(graphql): GraphQL live queries require the optional 'graphql-sse' package. Install it or pass live: false.");
        assert.equal(error.cause.code, 'ERR_MODULE_NOT_FOUND');
      `,
    ],
    { cwd: fixture, timeout: 10_000 },
  );
});
