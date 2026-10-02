import { Injectable, computed, effect, signal, untracked } from '@angular/core';

import {
  STORAGE_KEY,
  parseStoredProgress,
  reconcile,
  serialise,
  toggleIn,
  type LoadOutcome,
  type StorageIssue,
} from './progress-core';

const WRITE_DEBOUNCE_MS = 300;

const ISSUE_MESSAGES: Record<StorageIssue, string> = {
  unavailable: 'localStorage is unavailable, so progress will not be saved.',
  corrupted: 'Saved progress was corrupted and has been ignored.',
  unreadable: 'Saved progress had an unexpected format and has been ignored.',
};

/**
 * Which items the player has obtained, backed by localStorage.
 *
 * This is the signal/effect shell; all parsing, migration and reconciliation
 * decisions live in `progress-core.ts` so they can be tested without Angular.
 */
@Injectable({ providedIn: 'root' })
export class ProgressStore {
  private readonly checked = signal<ReadonlySet<number>>(new Set());
  private readonly lastLoad = signal<LoadOutcome | null>(null);
  private readonly persistenceError = signal<string | null>(null);

  /** The snapshot schema version the current state was recorded against. */
  private schemaVersion = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set during bulk loads so restoring state does not immediately write it back. */
  private suppressWrites = false;

  /** Number of items ticked. */
  readonly count = computed(() => this.checked().size);

  /** How the last load went, so the UI can report dropped ids or a schema change. */
  readonly loadResult = computed(() => this.lastLoad());

  /** Set when progress cannot be persisted, so the UI can warn rather than pretend. */
  readonly error = computed(() => this.persistenceError());

  constructor() {
    effect(() => {
      const current = this.checked();
      untracked(() => {
        if (this.suppressWrites) return;
        this.scheduleWrite(current);
      });
    });
  }

  isChecked(id: number): boolean {
    return this.checked().has(id);
  }

  toggle(id: number): void {
    this.checked.update((set) => toggleIn(set, id));
  }

  setChecked(id: number, value: boolean): void {
    const current = this.checked();
    if (current.has(id) === value) return;
    this.checked.update((set) => toggleIn(set, id));
  }

  setMany(ids: readonly number[], value: boolean): void {
    this.checked.update((set) => {
      const next = new Set(set);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  clear(): void {
    this.checked.set(new Set());
  }

  /**
   * Load persisted progress and reconcile it against the snapshot.
   *
   * Stale ids are dropped rather than kept: a kept id would inflate the count
   * with an item the player can never see or untick.
   */
  load(schemaVersion: number, validIds: ReadonlySet<number>): void {
    this.schemaVersion = schemaVersion;

    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      this.persistenceError.set(ISSUE_MESSAGES.unavailable);
      this.lastLoad.set({ ids: [], dropped: 0, schemaChanged: false, issue: 'unavailable' });
      return;
    }

    const parsed = parseStoredProgress(raw);
    if (!parsed.ok) {
      if (parsed.issue) this.persistenceError.set(ISSUE_MESSAGES[parsed.issue]);
      this.lastLoad.set({ ids: [], dropped: 0, schemaChanged: false, issue: parsed.issue });
      return;
    }

    const outcome = reconcile(parsed.data, schemaVersion, validIds);

    this.suppressWrites = true;
    this.checked.set(new Set(outcome.ids));
    this.suppressWrites = false;
    this.lastLoad.set(outcome);

    // Only rewrite when the load actually changed something, so viewing the app
    // does not churn storage.
    if (outcome.dropped > 0 || outcome.schemaChanged) {
      this.scheduleWrite(this.checked());
    }
  }

  /** Debounced so a rapid series of toggles produces a single write. */
  private scheduleWrite(set: ReadonlySet<number>): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.write(set);
    }, WRITE_DEBOUNCE_MS);
  }

  private write(set: ReadonlySet<number>): void {
    try {
      localStorage.setItem(STORAGE_KEY, serialise(set, this.schemaVersion));
      this.persistenceError.set(null);
    } catch (err) {
      // Quota exceeded or storage disabled. Losing persistence is bad; losing the
      // session by throwing is worse.
      this.persistenceError.set(
        `Could not save progress (${err instanceof Error ? err.name : 'storage error'}).`,
      );
    }
  }
}
