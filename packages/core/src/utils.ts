// SPDX-License-Identifier: Apache-2.0
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
 * Runtime: strips keys whose values are undefined.
 * Type: returns T (safe cast - only optional fields should have undefined values).
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
export function omitUndefined<T extends object>(
  obj: { [K in keyof T]: T[K] | undefined },
): T {
  const result = {} as T;
  for (const key in obj) {
    const value = obj[key as keyof typeof obj];
    if (value !== undefined) result[key as keyof T] = value as T[keyof T];
  }
  return result;
}
