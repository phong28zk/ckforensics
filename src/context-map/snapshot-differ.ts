/**
 * Snapshot differ: computes the token movement between two context snapshots.
 *
 * Items are matched by id (deterministic hash). An item present in B but
 * not A is "added"; present in A but not B is "dropped".
 *
 * Cross-session diffs are allowed but emit a warning — the comparison is
 * still semantically valid (same item IDs can appear across sessions when
 * the same tool is called with identical inputs).
 */

import type {
  ContextSnapshot,
  ContextItem,
  SnapshotDiff,
  CategoryDelta,
} from "./types.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Diff snapshot A against snapshot B.
 *
 * @returns SnapshotDiff with added/dropped items, net token delta, and
 *          per-category breakdown.
 */
export function diff(a: ContextSnapshot, b: ContextSnapshot): SnapshotDiff {
  const aById = new Map<string, ContextItem>(a.items.map((it) => [it.id, it]));
  const bById = new Map<string, ContextItem>(b.items.map((it) => [it.id, it]));

  const addedItems: ContextItem[] = [];
  const droppedItems: ContextItem[] = [];

  // Items in B not in A → added
  for (const [id, item] of bById) {
    if (!aById.has(id)) addedItems.push(item);
  }

  // Items in A not in B → dropped
  for (const [id, item] of aById) {
    if (!bById.has(id)) droppedItems.push(item);
  }

  const netTokenDelta = b.totalTokens - a.totalTokens;
  const categoryDeltas = computeCategoryDeltas(a.items, b.items);

  const crossSessionWarning =
    a.sessionId !== b.sessionId
      ? `Snapshots are from different sessions (${a.sessionId} vs ${b.sessionId}). ` +
        "Diff is still valid but may be misleading."
      : undefined;

  return {
    snapshotIdA: a.id,
    snapshotIdB: b.id,
    addedItems,
    droppedItems,
    netTokenDelta,
    categoryDeltas,
    crossSessionWarning,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function itemCategory(item: ContextItem): string {
  const src = item.source;
  switch (src.type) {
    case "tool_result":
      return `tool_result:${src.toolName}`;
    case "assistant_message":
      return "assistant_message";
    case "user_message":
      return "user_message";
    case "system_prompt":
      return "system_prompt";
    case "memory":
      return "memory";
    case "skill_load":
      return "skill_load";
    case "unknown":
      return "unknown";
  }
}

function computeCategoryDeltas(
  aItems: ContextItem[],
  bItems: ContextItem[]
): CategoryDelta[] {
  const aByCategory = groupTokensByCategory(aItems);
  const bByCategory = groupTokensByCategory(bItems);

  const categories = new Set([
    ...aByCategory.keys(),
    ...bByCategory.keys(),
  ]);

  const deltas: CategoryDelta[] = [];
  for (const cat of categories) {
    const before = aByCategory.get(cat) ?? 0;
    const after = bByCategory.get(cat) ?? 0;
    deltas.push({ category: cat, tokensBefore: before, tokensAfter: after, delta: after - before });
  }

  // Sort by abs(delta) desc for readability
  deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return deltas;
}

function groupTokensByCategory(items: ContextItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    const cat = itemCategory(item);
    m.set(cat, (m.get(cat) ?? 0) + item.tokens);
  }
  return m;
}
