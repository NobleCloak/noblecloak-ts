import type { Ref, RefCallback } from 'react';

/** One ref callback that sets every ref it is given (an object ref's `current`, or a callback ref). */
export function mergeRefs<T>(...refs: readonly (Ref<T> | undefined)[]): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value);
      else if (ref !== null && ref !== undefined) ref.current = value;
    }
  };
}
