import type { SelectionPlan } from './selection.ts';

export const getFieldKey = (path: string, plan?: SelectionPlan): string => {
  const field = path.slice(path.lastIndexOf('.') + 1);
  const args = plan?.args.get(path);
  // Connections already keep argument-specific list state independently of the owner field.
  return args && !args.ignoreKeys && Object.keys(args.value).length
    ? `${field}(${encodeURIComponent(args.hash).replaceAll('.', '%2E')})`
    : field;
};

export const getStoragePath = (path: string, plan?: SelectionPlan, prefix = ''): string => {
  if (!plan?.args.size) {
    return path;
  }
  let current = prefix;
  return path
    .split('.')
    .map((field) => {
      current = current ? `${current}.${field}` : field;
      return getFieldKey(current, plan);
    })
    .join('.');
};
