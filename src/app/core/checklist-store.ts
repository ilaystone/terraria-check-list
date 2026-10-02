import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { SnapshotRepository } from './snapshot-repository';
import { ProgressStore } from './progress-store';
import {
  difficultiesOf,
  hasSource,
  type ItemIndexRow,
  type ItemSources,
  type NpcRef,
  type Snapshot,
} from './models';

export type Tier = 'curated' | 'all';

/** Which item ids a "check all" style action should apply to. */
export type BulkScope = 'visible' | 'filtered' | 'category';

function matchesQuery(item: ItemIndexRow, query: string): boolean {
  return item.nameLower.includes(query);
}

/**
 * Application state: the loaded snapshot plus the active filters, the visible
 * page, and the derived counts the sidebar needs.
 *
 * Kept in one service rather than spread across components because the filter
 * state is shared: the sidebar sets the category, the toolbar sets the search,
 * and both must agree on what "filtered" means. Components stay presentational.
 */
@Injectable({ providedIn: 'root' })
export class ChecklistStore {
  private readonly repo = inject(SnapshotRepository);
  private readonly progress = inject(ProgressStore);

  private readonly tierSignal = signal<Tier>('curated');
  private readonly querySignal = signal('');
  /**
   * One value covers both levels: either a category name ("Weapons") or a
   * subtype name ("Broadswords"). Two separate signals would need rules for
   * keeping them consistent; one value cannot disagree with itself.
   */
  private readonly categorySignal = signal<string | null>(null);
  private readonly sourceBitsSignal = signal<number>(0);
  private readonly limitSignal = signal(100);
  private readonly showCheckedSignal = signal(true);

  readonly tier = this.tierSignal.asReadonly();
  readonly query = this.querySignal.asReadonly();
  readonly category = this.categorySignal.asReadonly();
  readonly sourceBits = this.sourceBitsSignal.asReadonly();
  readonly showChecked = this.showCheckedSignal.asReadonly();

  readonly snapshot = this.repo.snapshot;
  readonly isReady = this.repo.isReady;
  readonly isLoading = this.repo.isLoading;
  readonly loadError = this.repo.error;
  readonly categories = this.repo.categories;
  readonly subtypes = this.repo.subtypes;
  readonly sourceFlags = this.repo.sourceFlags;
  readonly unknownBit = this.repo.unknownBit;

  readonly checkedCount = this.progress.count;
  readonly progressError = this.progress.error;
  readonly progressLoad = this.progress.loadResult;

  /** Set of every id in the snapshot, used to drop stale ids on load. */
  private readonly validIds = computed<ReadonlySet<number>>(() => {
    const snap = this.repo.snapshot();
    return new Set(snap ? snap.items.map((i) => i.id) : []);
  });

  /** Lowercased name -> id, for linking recipe ingredients back to their items. */
  private readonly nameToId = computed<ReadonlyMap<string, number>>(() => {
    const snap = this.repo.snapshot();
    if (!snap) return new Map();
    return new Map(snap.items.map((i) => [i.nameLower, i.id]));
  });

  constructor() {
    // Restore progress once the snapshot arrives. An effect is used rather than a
    // component hook so a page refresh on any route restores state identically.
    effect(() => {
      const snap = this.repo.snapshot();
      if (!snap) return;
      const ids = untracked(this.validIds);
      untracked(() => this.progress.load(snap.catalog.meta.schemaVersion, ids));
    });
  }

  // ---------------------------------------------------------------- mutations

  setTier(tier: Tier): void {
    this.tierSignal.set(tier);
    this.resetPage();
  }

  setQuery(query: string): void {
    this.querySignal.set(query.trim().toLowerCase());
    this.resetPage();
  }

  setCategory(category: string | null): void {
    this.categorySignal.set(category);
    this.resetPage();
  }

  /** Toggle one source tag on or off. Tags are additive: any match is included. */
  toggleSource(bitIndex: number): void {
    const bit = 1 << bitIndex;
    this.sourceBitsSignal.update((mask) => mask ^ bit);
    this.resetPage();
  }

  clearSources(): void {
    this.sourceBitsSignal.set(0);
    this.resetPage();
  }

  setShowChecked(value: boolean): void {
    this.showCheckedSignal.set(value);
    this.resetPage();
  }

  loadMore(): void {
    this.limitSignal.update((n) => n + 100);
  }

  private resetPage(): void {
    this.limitSignal.set(100);
  }

  // ------------------------------------------------------------------ derived

  /**
   * Items matching tier, search, category and source filters.
   *
   * Source filtering is `(src & selected) !== 0` — an item matches if it is
   * obtainable by *any* selected route, which is what a player filtering for
   * "things I can craft or buy" means. Requiring all bits would be AND, which
   * would almost always return nothing.
   */
  readonly filtered = computed<readonly ItemIndexRow[]>(() => {
    const snap = this.repo.snapshot();
    if (!snap) return [];

    const tier = this.tierSignal();
    const query = this.querySignal();
    const category = this.categorySignal();
    const sourceBits = this.sourceBitsSignal();

    const categoryIdx = category === null ? -1 : snap.catalog.categories.indexOf(category);
    const subtypeIdx =
      category === null ? -1 : (snap.catalog.subtypes ?? []).findIndex((s) => s.name === category);

    return snap.items.filter((item) => {
      if (tier === 'curated' && !item.curated) return false;
      if (query && !matchesQuery(item, query)) return false;
      if (category !== null) {
        if (categoryIdx >= 0 && item.categoryIdx !== categoryIdx) return false;
        if (categoryIdx < 0 && (subtypeIdx < 0 || item.subIdx !== subtypeIdx)) return false;
      }
      if (sourceBits !== 0 && (item.src & sourceBits) === 0) return false;
      return true;
    });
  });

  /**
   * Filtered items doing double duty as the visible page: the list renders
   * `visible()` and a "load more" control raises the limit. This avoids a
   * virtual-scroll dependency for a list that is already narrowed by filters.
   */
  readonly visible = computed<readonly ItemIndexRow[]>(() =>
    this.filtered().slice(0, this.limitSignal()),
  );

  readonly hasMore = computed(() => this.filtered().length > this.limitSignal());

  /** Item count per category for the current tier and search, for the sidebar. */
  readonly categoryCounts = computed<ReadonlyMap<string, number>>(() => {
    const snap = this.repo.snapshot();
    if (!snap) return new Map();

    const tier = this.tierSignal();
    const query = this.querySignal();
    const counts = new Map<string, number>();

    for (const item of snap.items) {
      if (tier === 'curated' && !item.curated) continue;
      if (query && !matchesQuery(item, query)) continue;
      const name = snap.catalog.categories[item.categoryIdx];
      if (name === undefined) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  });

  /**
   * Item count per source tag. An item counts once per route it has, so these
   * deliberately sum above the item total — they answer "how many can be
   * crafted", not "how many are craft-only".
   */
  readonly sourceCounts = computed<readonly number[]>(() => {
    const snap = this.repo.snapshot();
    if (!snap) return [];
    const tier = this.tierSignal();
    const query = this.querySignal();
    const counts = new Array<number>(snap.catalog.sourceFlags.length).fill(0);

    for (const item of snap.items) {
      if (tier === 'curated' && !item.curated) continue;
      if (query && !matchesQuery(item, query)) continue;
      for (let i = 0; i < counts.length; i++) {
        if (hasSource(item.src, i)) counts[i] += 1;
      }
    }
    return counts;
  });

  /** How many of the filtered items are ticked, for a "12 / 40 collected" readout. */
  readonly filteredCheckedCount = computed(() => {
    const progress = this.progress;
    let n = 0;
    for (const item of this.filtered()) if (progress.isChecked(item.id)) n += 1;
    return n;
  });

  /** Items in the active tier, ignoring every filter. The progress denominator. */
  private readonly tierItemsList = computed<readonly ItemIndexRow[]>(() => {
    const snap = this.repo.snapshot();
    if (!snap) return [];
    return this.tierSignal() === 'curated' ? snap.items.filter((i) => i.curated) : snap.items;
  });

  readonly tierItems = computed(() => this.tierItemsList().length);

  /** Ticked items within the active tier, ignoring filters. The progress numerator. */
  readonly checkedInTier = computed(() => {
    const progress = this.progress;
    let n = 0;
    for (const item of this.tierItemsList()) if (progress.isChecked(item.id)) n += 1;
    return n;
  });

  /**
   * Tri-state for a "tick everything" control: none, some or all of the active tier.
   *
   * Precomputed here rather than as `items().every(isChecked)` in a template: that
   * form would register thousands of signal dependencies per change detection pass.
   */
  readonly tierSelectionState = computed<'none' | 'some' | 'all'>(() => {
    const total = this.tierItems();
    if (total === 0) return 'none';
    const checked = this.checkedInTier();
    if (checked === 0) return 'none';
    return checked === total ? 'all' : 'some';
  });

  /** Re-fetch the snapshot, e.g. after a failed load. */
  reloadData(): void {
    this.repo.reload();
  }

  /**
   * Subtypes available for the current selection, whether a category or a
   * subtype is selected. Resolving through the parent keeps the kind chips
   * visible after picking one, so switching kinds does not require going back up.
   */
  readonly subtypesOfActiveCategory = computed<readonly string[]>(() => {
    const active = this.categorySignal();
    if (active === null) return [];
    const subtypes = this.repo.subtypes();
    // Either the selection is a parent that owns subtypes, or it is itself a subtype.
    const parent = subtypes.some((s) => s.parent === active)
      ? active
      : (subtypes.find((s) => s.name === active)?.parent ?? active);
    return subtypes.filter((s) => s.parent === parent).map((s) => s.name);
  });

  // ------------------------------------------------------------- bulk actions

  idsForScope(scope: BulkScope): readonly number[] {
    switch (scope) {
      case 'visible':
        return this.visible().map((i) => i.id);
      case 'filtered':
        return this.filtered().map((i) => i.id);
      case 'category':
        return this.filtered().map((i) => i.id);
    }
  }

  checkAll(scope: BulkScope): void {
    this.progress.setMany(this.idsForScope(scope), true);
  }

  uncheckAll(scope: BulkScope): void {
    this.progress.setMany(this.idsForScope(scope), false);
  }

  clearAllProgress(): void {
    this.progress.clear();
  }

  // --------------------------------------------------------------- accessors

  toggleItem(id: number): void {
    this.progress.toggle(id);
  }

  isChecked(id: number): boolean {
    return this.progress.isChecked(id);
  }

  itemById(id: number): ItemIndexRow | undefined {
    return this.repo.snapshot()?.items.find((i) => i.id === id);
  }

  detailById(id: number) {
    const snap: Snapshot | null = this.repo.snapshot();
    return snap ? (snap.details[String(id)] ?? null) : null;
  }

  /** Recipes, drops and vendors for an item, or `null` when it has none. */
  sourcesById(id: number): ItemSources | null {
    return this.repo.sources()[String(id)] ?? null;
  }

  /** Display info for a drop source name, or `null` for non-enemies (crates, chests). */
  npcByName(name: string): NpcRef | null {
    return this.repo.npcs()[name] ?? null;
  }

  difficultyNames(mask: number | undefined): string[] {
    return difficultiesOf(mask, this.repo.difficulties(), this.repo.difficultyBits());
  }

  /**
   * Item id for a name, or `null`.
   *
   * Used to turn a recipe ingredient into a link. Returns `null` for ingredient
   * *groups* like "Any Wood" or "Any Iron Bar", which are not items — linking
   * those would produce a 404 route.
   */
  idByName(name: string): number | null {
    return this.nameToId().get(name.toLowerCase()) ?? null;
  }

  subtypeParentOf(name: string): string | undefined {
    return this.repo.subtypes().find((s) => s.name === name)?.parent;
  }
}
