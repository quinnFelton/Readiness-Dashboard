/** Move the item at `index` by `delta` (-1 up / +1 down); returns a new array, no-op at edges. */
export function moveSource(order: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
