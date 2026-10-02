/**
 * Pure progress logic: parsing, migration and reconciliation.
 *
 * Kept free of Angular so it can be tested without a TestBed, an injection
 * context or change-detection ticks. `ProgressStore` is the signal/effect shell
 * around these functions; every branch worth asserting lives here.
 *
 * Progress is keyed on item **id** and stored as a flat list:
 *  - names drift between wiki snapshots, ids do not
 *  - array indices shift when a snapshot is regenerated, ids do not
 */

export const STORAGE_KEY = 'terraria-checklist.progress';

/** Why a load could not use stored data. */
export type StorageIssue = 'unavailable' | 'corrupted' | 'unreadable';

export interface StoredProgress {
  /** Snapshot schema version the ids were recorded against. */
  v: number;
  ids: number[];
  updatedAt?: string;
}

export interface LoadOutcome {
  /** Ids to restore, in ascending order. */
  readonly ids: readonly number[];
  /** Ids present in storage but absent from the snapshot, therefore discarded. */
  readonly dropped: number;
  /** True when storage was written against a different schema version. */
  readonly schemaChanged: boolean;
  /** Set when stored data could not be used at all. */
  readonly issue: StorageIssue | null;
}

/**
 * Parse the persisted payload.
 *
 * Returns a discriminated result rather than throwing: corrupted storage must
 * degrade to "no progress" and never break the page.
 */
export function parseStoredProgress(
  text: string | null,
): { ok: true; data: StoredProgress } | { ok: false; issue: StorageIssue | null } {
  if (text === null || text === '') return { ok: false, issue: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, issue: 'corrupted' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, issue: 'unreadable' };
  }

  const candidate = parsed as Partial<StoredProgress>;
  if (!Array.isArray(candidate.ids)) return { ok: false, issue: 'unreadable' };

  return {
    ok: true,
    data: {
      v: typeof candidate.v === 'number' && Number.isFinite(candidate.v) ? candidate.v : 0,
      // Non-integer junk in the array is discarded rather than trusted.
      ids: candidate.ids.filter((id): id is number => Number.isInteger(id) && id > 0),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
    },
  };
}

/**
 * Reconcile stored progress against the current snapshot.
 *
 * @param stored parsed payload, or `null` when nothing was stored
 * @param schemaVersion `catalog.meta.schemaVersion` of the loaded snapshot
 * @param validIds every id present in the snapshot
 */
export function reconcile(
  stored: StoredProgress | null,
  schemaVersion: number,
  validIds: ReadonlySet<number>,
): LoadOutcome {
  if (!stored) {
    return { ids: [], dropped: 0, schemaChanged: false, issue: null };
  }

  const restored: number[] = [];
  let dropped = 0;
  for (const id of stored.ids) {
    if (validIds.has(id)) restored.push(id);
    else dropped += 1;
  }

  return {
    ids: restored,
    dropped,
    schemaChanged: stored.v !== schemaVersion,
    issue: null,
  };
}

/** Serialise progress for storage. Sorted, so the payload is stable and diffable. */
export function serialise(ids: ReadonlySet<number>, schemaVersion: number): string {
  const payload: StoredProgress = {
    v: schemaVersion,
    ids: [...ids].sort((a, b) => a - b),
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

/** Immutable toggle that preserves set identity when nothing changes. */
export function toggleIn(set: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}
