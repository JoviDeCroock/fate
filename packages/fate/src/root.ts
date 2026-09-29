import type { AnyRecord, RootDefinition, TypeName } from './types.ts';
import { RootKind } from './types.ts';

/**
 * Defines a root query for an entity type, capturing the response shape.
 */
export function clientRoot<Result, Type extends TypeName, Args = AnyRecord>(
  type: Type,
): RootDefinition<Type, Result, Args> {
  return Object.freeze({
    [RootKind]: true,
    type,
  }) as RootDefinition<Type, Result, Args>;
}

export function clientValueRoot<Result, Args = AnyRecord>(): RootDefinition<
  '__value__',
  Result,
  Args
> {
  return clientRoot<Result, '__value__', Args>('__value__');
}
