// D1 caps a single statement at 100 bound parameters; a bulk INSERT or a
// long inArray() that exceeds it fails with "D1_ERROR: too many SQL
// variables". Callers split their row/id lists with this helper so each
// statement stays under the cap.
export const D1_MAX_BOUND_PARAMS = 100

/**
 * Split `items` into chunks sized so each resulting statement binds at most
 * D1_MAX_BOUND_PARAMS variables.
 *
 * @param paramsPerItem worst-case bound params contributed per item (for a
 *   bulk insert: the table's column count; for inArray ids: 1).
 * @param reservedParams params the statement binds outside the item list
 *   (e.g. extra WHERE conditions alongside an inArray).
 */
export function chunkForBoundParams<T>(
  items: readonly T[],
  paramsPerItem: number,
  reservedParams = 0,
): T[][] {
  const size = Math.max(1, Math.floor((D1_MAX_BOUND_PARAMS - reservedParams) / paramsPerItem))
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}
