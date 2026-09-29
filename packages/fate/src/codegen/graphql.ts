import { createRequire } from 'node:module';
import type { GraphQLSchema } from 'graphql';
import type { GraphQLArgumentSchema, GraphQLArguments } from '../graphqlSchema.ts';

const require = createRequire(import.meta.url);

const argument = (value: { default?: unknown; defaultValue?: unknown; type: unknown }) => ({
  ...(value.default !== undefined || value.defaultValue !== undefined
    ? { hasDefault: true }
    : null),
  type: String(value.type),
});

/** Extracts serializable argument metadata without shipping GraphQL's schema implementation. */
export function createGraphQLArgumentSchema(source: string | GraphQLSchema): GraphQLArgumentSchema {
  const schema =
    typeof source === 'string'
      ? (require('graphql') as typeof import('graphql')).buildSchema(source)
      : source;
  const queryType = schema.getQueryType()?.name;
  if (!queryType) {
    throw new Error('fate(graphql): The schema must have a query type.');
  }
  const fields: Record<string, Record<string, GraphQLArguments>> = {};
  const inputs: Record<string, GraphQLArgumentSchema['inputs'][string]> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (name.startsWith('__')) {
      continue;
    }
    if ('getFields' in type && 'getInterfaces' in type) {
      fields[name] = Object.fromEntries(
        Object.entries(type.getFields()).map(([name, field]) => [
          name,
          Object.fromEntries(field.args.map((arg) => [arg.name, argument(arg)])),
        ]),
      );
    } else if ('getValues' in type) {
      inputs[name] = { kind: 'enum', values: type.getValues().map(({ name }) => name) };
    } else if ('getFields' in type) {
      inputs[name] = {
        fields: Object.fromEntries(
          Object.entries(type.getFields()).map(([name, field]) => [name, argument(field)]),
        ),
        kind: 'object',
      };
    }
  }
  return {
    fields,
    inputs,
    mutationType: schema.getMutationType()?.name,
    queryType,
    subscriptionType: schema.getSubscriptionType()?.name,
  };
}

export const graphQLTypeScriptType = (type: string, schema: GraphQLArgumentSchema): string => {
  const nonNull = type.endsWith('!');
  const name = nonNull ? type.slice(0, -1) : type;
  const value = name.startsWith('[')
    ? `ReadonlyArray<${graphQLTypeScriptType(name.slice(1, -1), schema)}>`
    : schema.inputs[name]
      ? `GraphQLInputs[${JSON.stringify(name)}]`
      : ({
          Boolean: 'boolean',
          Float: 'number',
          ID: 'string | number',
          Int: 'number',
          String: 'string',
        }[name] ?? 'unknown');
  return nonNull ? value : `${value} | null`;
};

export const graphQLArgumentsType = (
  args: GraphQLArguments,
  schema: GraphQLArgumentSchema,
): string => {
  const fields = Object.entries(args).map(
    ([name, arg]) =>
      `readonly ${JSON.stringify(name)}${arg.type.endsWith('!') && !arg.hasDefault ? '' : '?'}: ${graphQLTypeScriptType(arg.type, schema)};`,
  );
  return fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, never>';
};

export const graphQLArgumentContracts = (schema: GraphQLArgumentSchema): string => `
export type GraphQLInputs = {
${Object.entries(schema.inputs)
  .map(
    ([name, input]) =>
      `  readonly ${JSON.stringify(name)}: ${input.kind === 'enum' ? input.values.map((value) => JSON.stringify(value)).join(' | ') : graphQLArgumentsType(input.fields, schema)};`,
  )
  .join('\n')}
};

export type GraphQLFieldArguments = {
${Object.entries(schema.fields)
  .map(
    ([type, fields]) =>
      `  readonly ${JSON.stringify(type)}: {\n${Object.entries(fields)
        .map(
          ([field, args]) =>
            `    readonly ${JSON.stringify(field)}: ${graphQLArgumentsType(args, schema)};`,
        )
        .join('\n')}\n  };`,
  )
  .join('\n')}
};
`;
