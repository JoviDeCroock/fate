const ConditionTag = Symbol('fate.condition');

export type ConditionalSelection<C extends boolean = boolean, S = unknown> = Readonly<{
  condition: C;
  [ConditionTag]: true;
  selection: S;
}>;

/** Include a field or named fragment only when the condition is true. */
export function when<const C extends boolean, const S>(
  condition: C,
  selection: S,
): ConditionalSelection<C, S> {
  if (typeof condition !== 'boolean') {
    throw new Error('fate: A selection condition must be a boolean.');
  }
  return Object.freeze({ condition, [ConditionTag]: true, selection });
}

export const isConditionalSelection = (value: unknown): value is ConditionalSelection =>
  Boolean(value && typeof value === 'object' && ConditionTag in value);

export const resolveConditionalSelection = (value: unknown): unknown => {
  while (isConditionalSelection(value)) {
    if (!value.condition) {
      return undefined;
    }
    value = value.selection;
  }
  return value;
};
