import { isRecord } from './record.ts';

export type GraphQLArgument = Readonly<{ hasDefault?: boolean; type: string }>;
export type GraphQLArguments = Readonly<Record<string, GraphQLArgument>>;

/** Build-time schema metadata needed to validate inputs and declare wire variables. */
export type GraphQLArgumentSchema = Readonly<{
  fields: Readonly<Record<string, Readonly<Record<string, GraphQLArguments>>>>;
  inputs: Readonly<
    Record<
      string,
      | Readonly<{ kind: 'enum'; values: ReadonlyArray<string> }>
      | Readonly<{ fields: GraphQLArguments; kind: 'object' }>
    >
  >;
  mutationType?: string;
  queryType: string;
  subscriptionType?: string;
}>;

const invalidInput = (path: string, type: string): never => {
  throw new Error(`fate(graphql): Invalid input '${path}'; expected ${type}.`);
};

export const validateGraphQLInput = (
  schema: GraphQLArgumentSchema,
  type: string,
  value: unknown,
  path: string,
): unknown => {
  if (value == null) {
    return type.endsWith('!') ? invalidInput(path, type) : null;
  }
  const nullableType = type.endsWith('!') ? type.slice(0, -1) : type;
  if (nullableType.startsWith('[')) {
    const itemType = nullableType.slice(1, -1);
    return (Array.isArray(value) ? value : [value]).map((item, index) =>
      validateGraphQLInput(schema, itemType, item, `${path}[${index}]`),
    );
  }
  const input = schema.inputs[nullableType];
  if (input?.kind === 'enum') {
    return typeof value === 'string' && input.values.includes(value)
      ? value
      : invalidInput(path, type);
  }
  if (input?.kind === 'object') {
    if (!isRecord(value)) {
      return invalidInput(path, type);
    }
    return validateGraphQLArguments(schema, input.fields, value, path);
  }
  switch (nullableType) {
    case 'Boolean':
      return typeof value === 'boolean' ? value : invalidInput(path, type);
    case 'String':
      return typeof value === 'string' ? value : invalidInput(path, type);
    case 'ID':
      return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
        ? value
        : invalidInput(path, type);
    case 'Int':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= -2_147_483_648 &&
        value <= 2_147_483_647
        ? value
        : invalidInput(path, type);
    case 'Float':
      return typeof value === 'number' && Number.isFinite(value) ? value : invalidInput(path, type);
    default:
      return value;
  }
};

export const validateGraphQLArguments = (
  schema: GraphQLArgumentSchema,
  definitions: GraphQLArguments,
  values: Readonly<Record<string, unknown>> | undefined,
  path: string,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(values ?? {})) {
    if (!Object.hasOwn(definitions, key)) {
      throw new Error(`fate(graphql): Unknown argument '${path}.${key}'.`);
    }
  }
  for (const [key, definition] of Object.entries(definitions)) {
    const value = values?.[key];
    if (value === undefined) {
      if (definition.type.endsWith('!') && !definition.hasDefault) {
        invalidInput(`${path}.${key}`, definition.type);
      }
      continue;
    }
    result[key] = validateGraphQLInput(schema, definition.type, value, `${path}.${key}`);
  }
  return result;
};
