import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';

import type {
  Catalog,
  ItemDetail,
  ItemIndexRow,
  ItemSources,
  NpcRef,
  Refs,
  Snapshot,
} from './models';

/** Where the generated snapshot is served from. `public/data/` is copied to the build root. */
const DATA_BASE = 'data';

/**
 * Loads the committed wiki snapshot.
 *
 * The snapshot is three static JSON files, so there is no backend and no runtime
 * wiki access — see `tools/snapshot/README.md` for why that is a hard constraint
 * rather than a preference. `public/data/` is copied verbatim into the build, so
 * these resolve to `/data/*.json`.
 *
 * Exposes Angular `resource`s, which carry loading and error state as signals, so
 * components need no manual state machine and no `async` pipe.
 */
@Injectable({ providedIn: 'root' })
export class SnapshotRepository {
  private readonly catalogResource = httpResource<Catalog>(() => `${DATA_BASE}/catalog.json`);
  private readonly itemsResource = httpResource<ItemIndexRow[]>(() => `${DATA_BASE}/items.index.json`);
  private readonly detailsResource = httpResource<Record<string, ItemDetail>>(
    () => `${DATA_BASE}/items.detail.json`,
  );
  /**
   * Full acquisition detail (recipes, drops, vendors). Separate from the index
   * because the list view never shows a recipe, and separate from `refs` because
   * only a drop source needs an enemy's display name.
   */
  private readonly sourcesResource = httpResource<Record<string, ItemSources>>(
    () => `${DATA_BASE}/items.sources.json`,
  );
  private readonly refsResource = httpResource<Refs>(() => `${DATA_BASE}/refs.json`);

  /** True once every payload has arrived. */
  readonly isReady = computed(
    () =>
      this.catalogResource.hasValue() &&
      this.itemsResource.hasValue() &&
      this.detailsResource.hasValue() &&
      this.sourcesResource.hasValue() &&
      this.refsResource.hasValue(),
  );

  /** True while any payload is still in flight. */
  readonly isLoading = computed(
    () =>
      this.catalogResource.isLoading() ||
      this.itemsResource.isLoading() ||
      this.detailsResource.isLoading() ||
      this.sourcesResource.isLoading() ||
      this.refsResource.isLoading(),
  );

  /**
   * Human-readable failure reason, or `null`.
   *
   * A missing or malformed snapshot is the likeliest deployment mistake, so the
   * message names the file and the fix instead of surfacing a bare HTTP status.
   */
  readonly error = computed<string | null>(() => {
    const failures: readonly (readonly [string, unknown])[] = [
      ['catalog.json', this.catalogResource.error()],
      ['items.index.json', this.itemsResource.error()],
      ['items.detail.json', this.detailsResource.error()],
      ['items.sources.json', this.sourcesResource.error()],
      ['refs.json', this.refsResource.error()],
    ];
    const failed = failures.find(([, err]) => !!err);
    if (!failed) return null;
    return (
      `Could not load data/${failed[0]}. The wiki snapshot may not have been built. ` +
      `Run \`npm run gather\` (or \`npm run gather:offline\` to use the cache), then reload.`
    );
  });

  /** The full snapshot, or `null` until every file has loaded. */
  readonly snapshot = computed<Snapshot | null>(() => {
    const catalog = this.catalogResource.value();
    const items = this.itemsResource.value();
    const details = this.detailsResource.value();
    if (!catalog || !items || !details) return null;
    return { catalog, items, details };
  });

  /** Category names, or `[]` before load. */
  readonly categories = computed<readonly string[]>(() => this.catalogResource.value()?.categories ?? []);

  /** Source tag names, or `[]` before load. */
  readonly sourceFlags = computed<readonly string[]>(
    () => this.catalogResource.value()?.sourceFlags ?? [],
  );

  /** The bit meaning "no route found". */
  readonly unknownBit = computed<number>(() => this.catalogResource.value()?.unknownBit ?? 0);

  /** Finer kinds (weapons only), or `[]` before load or on pre-v3 snapshots. */
  readonly subtypes = computed(() => this.catalogResource.value()?.subtypes ?? []);

  /** Difficulty names in bit order. */
  readonly difficulties = computed(() => this.catalogResource.value()?.difficulties ?? []);

  /** Bit per difficulty name. */
  readonly difficultyBits = computed(() => this.catalogResource.value()?.difficultyBits);

  /** Full acquisition detail, keyed by item id as a string. */
  readonly sources = computed<Readonly<Record<string, ItemSources>>>(
    () => this.sourcesResource.value() ?? {},
  );

  /** Enemy lookup for drop sources. */
  readonly npcs = computed<Readonly<Record<string, NpcRef>>>(
    () => this.refsResource.value()?.npcs ?? {},
  );

  /** Re-fetch all files, e.g. after a failed load. */
  reload(): void {
    this.catalogResource.reload();
    this.itemsResource.reload();
    this.detailsResource.reload();
    this.sourcesResource.reload();
    this.refsResource.reload();
  }
}
