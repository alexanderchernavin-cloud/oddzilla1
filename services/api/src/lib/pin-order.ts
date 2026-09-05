// Operator pin ordering for catalog rows (migration 0103).
//
// `sports.display_order` and `categories.display_order` hold a dense
// 1..N sequence over the PINNED rows of a scope — every sport globally,
// every non-dummy category of one sport. Unpinned rows carry NULL and
// keep whatever default ordering their surface already had, so a scope
// nobody has touched renders exactly as it did before this existed.
//
// Every admin action is expressed as a transform of that id list rather
// than as an arithmetic nudge on one row's value. Two reasons:
//
//   1. It makes the sequence self-healing. Whatever the rows held going
//      in — a gap left by a deleted category, duplicates written by
//      hand — the list comes back out dense and duplicate-free, because
//      the writer renumbers all of it from the array's index.
//   2. "Up" and "down" only have a meaning relative to the other pinned
//      rows. Deriving them from the list is exact; deriving them from
//      the stored integers would need the unpinned rows' fallback order
//      (alphabetical for categories, flagship-slugs-then-name for
//      sports) to be reproduced in SQL, which is where the display and
//      the storage would drift apart.
//
// Pure and total: an id that is not in the list is simply appended
// (pin), and "up" on the first row is a no-op rather than an error, so
// a double-click on a boundary button can't 500.

export type PinAction = "top" | "up" | "down" | "clear";

export const PIN_ACTIONS: readonly PinAction[] = ["top", "up", "down", "clear"];

/**
 * Apply one operator action to the ordered list of pinned ids.
 *
 * @param pinned ids currently pinned, in display order
 * @param id     the row the operator acted on
 * @returns the new pinned list — assign 1..N by index, NULL to the rest
 */
export function reorderPinned(
  pinned: readonly number[],
  id: number,
  action: PinAction,
): number[] {
  // Defensive dedupe: the caller reads from a table with no uniqueness
  // constraint on display_order, so two rows CAN arrive sharing a value.
  // Collapsing here means the write that follows fixes it.
  const list: number[] = [];
  for (const n of pinned) if (!list.includes(n)) list.push(n);

  const index = list.indexOf(id);

  if (action === "clear") {
    return index === -1 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
  }

  if (action === "top") {
    return [id, ...list.filter((n) => n !== id)];
  }

  // "up" / "down" on a row that isn't pinned yet has no neighbour to
  // trade with; the sensible reading is "put it in the list", and the
  // end is the only position that doesn't displace an explicit choice.
  if (index === -1) return [...list, id];

  const target = action === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= list.length) return list;

  const next = [...list];
  const swapped = list[target];
  if (swapped === undefined) return list;
  next[index] = swapped;
  next[target] = id;
  return next;
}
