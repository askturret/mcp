/**
 * Shared utility functions
 */

/**
 * Omit undefined values from an object.
 *
 * This helper addresses exactOptionalPropertyTypes violations where assigning
 * `field: undefined` is rejected by TypeScript. Instead of manually checking
 * each field, use this helper to strip undefined values before object construction.
 *
 * @param obj - Object potentially containing undefined values
 * @returns New object with undefined values omitted
 *
 * @example
 * ```ts
 * // Instead of:
 * const obj = { a: 1, b: undefined };  // TS error with exactOptionalPropertyTypes
 *
 * // Use:
 * const obj = omitUndefined({ a: 1, b: undefined });  // { a: 1 }
 * ```
 */
export function omitUndefined<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
