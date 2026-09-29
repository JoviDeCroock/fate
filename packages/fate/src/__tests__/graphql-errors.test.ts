import { expect, test } from 'vite-plus/test';
import { createGraphQLTransport } from '../graphqlTransport.ts';

const errors = [
  { extensions: { code: 'FORBIDDEN' }, message: 'Private field', path: ['f1', 'email'] },
  { extensions: { code: 'FAILED' }, message: 'Other field', path: ['f1', 'name'] },
];

const transportWith = (body: unknown, status = 200) =>
  createGraphQLTransport({
    fetch: async () => new Response(JSON.stringify(body), { status }),
    live: false,
    roots: { viewer: { type: 'User' } },
    types: [{ type: 'User' }],
    url: '/graphql',
  });

test('retains all execution errors and partial data without accepting an incomplete result', async () => {
  const transport = transportWith({ data: { f1: { id: 'User-1', name: null } }, errors });
  await expect(transport.fetchQuery!('viewer', new Set(['name']))).rejects.toMatchObject({
    data: { id: 'User-1', name: null },
    errors,
    extensions: { code: 'FORBIDDEN' },
    message: 'Private field',
    name: 'GraphQLRequestError',
    path: ['f1', 'email'],
    status: 200,
  });
});

test('retains HTTP status and GraphQL errors for a failed HTTP response', async () => {
  const transport = transportWith({ errors }, 403);
  await expect(transport.fetchQuery!('viewer', new Set(['name']))).rejects.toMatchObject({
    errors,
    status: 403,
  });
});

test('isolates aliased operation errors while accepting a legitimate null sibling', async () => {
  const transport = transportWith({ data: { f1: { id: 'User-1' }, f2: null }, errors });
  const results = await Promise.allSettled([
    transport.fetchQuery!('viewer', new Set(['name'])),
    transport.fetchQuery!('viewer', new Set(['id'])),
  ]);
  expect(results[0]).toMatchObject({ reason: { errors }, status: 'rejected' });
  expect(results[1]).toEqual({ status: 'fulfilled', value: null });
});
