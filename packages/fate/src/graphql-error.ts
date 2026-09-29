export type GraphQLErrorPayload = Readonly<{
  extensions?: Record<string, unknown>;
  message?: string;
  path?: ReadonlyArray<number | string>;
}>;

/** A failed GraphQL operation. Partial data is diagnostic and is never normalized. */
export class GraphQLRequestError extends Error {
  override readonly name = 'GraphQLRequestError';
  readonly errors: ReadonlyArray<GraphQLErrorPayload>;
  readonly status?: number;
  readonly data?: unknown;

  constructor(
    errors: ReadonlyArray<GraphQLErrorPayload>,
    options: { data?: unknown; message?: string; status?: number } = {},
  ) {
    super(errors[0]?.message ?? options.message ?? 'GraphQL request failed.');
    this.errors = Object.freeze([...errors]);
    this.status = options.status;
    this.data = options.data;
  }

  get extensions() {
    return this.errors[0]?.extensions;
  }

  get path() {
    return this.errors[0]?.path;
  }
}
