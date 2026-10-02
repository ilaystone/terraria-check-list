import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ChecklistStore } from '../../core/checklist-store';
import {
  difficultyLabel,
  formatCoins,
  sourceNames,
  spriteUrl,
  stationParts as stationPartsOf,
  type DropRates,
} from '../../core/models';

/** Maps a source tag to its daisyUI badge colour. Mirrors the list row. */
const SOURCE_BADGE: Record<string, string> = {
  craft: 'badge-success',
  drop: 'badge-warning',
  shop: 'badge-info',
  fished: 'badge-accent',
  unknown: 'badge-ghost',
};

/**
 * Detail view for a single item.
 *
 * The route parameter arrives as an `input()` because the router is configured
 * with `withComponentInputBinding()`. Note the conversion: route params are
 * strings, ids are numbers, and a non-numeric id must not silently become `NaN`
 * and match nothing without explanation.
 */
@Component({
  selector: 'app-item-detail-page',
  imports: [RouterLink],
  templateUrl: './item-detail-page.html',
  styleUrl: './item-detail-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemDetailPage {
  private readonly store = inject(ChecklistStore);

  /** Set by the router. `input()` rather than `input.required()` so an empty path still renders. */
  readonly id = input<string>('');

  protected readonly numericId = computed(() => {
    const parsed = Number(this.id());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  });

  protected readonly item = computed(() => {
    const id = this.numericId();
    return id === null ? undefined : this.store.itemById(id);
  });

  protected readonly detail = computed(() => {
    const id = this.numericId();
    return id === null ? null : this.store.detailById(id);
  });

  protected readonly checked = computed(() => {
    const item = this.item();
    return item ? this.store.isChecked(item.id) : false;
  });

  protected readonly categoryName = computed(() => {
    const item = this.item();
    return item ? (this.store.categories()[item.categoryIdx] ?? '') : '';
  });

  protected readonly subtypeName = computed(() => {
    const item = this.item();
    if (!item || item.subIdx === undefined) return null;
    return this.store.subtypes()[item.subIdx]?.name ?? null;
  });

  /** Source tag names for the badges under the title. */
  protected readonly sourceTags = computed(() => {
    const item = this.item();
    return item ? sourceNames(item.src, this.store.sourceFlags()) : [];
  });

  /** Copper values rendered as coin strings, or an em dash when absent. */
  protected readonly buyPrice = computed(() => formatCoins(this.detail()?.b));
  protected readonly sellPrice = computed(() => formatCoins(this.detail()?.sl));

  protected readonly flags = computed<readonly string[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    const out: string[] = [];
    if (detail.h) out.push('Hardmode');
    if (detail.p) out.push('Placeable');
    if (detail.c) out.push('Consumable');
    if (detail.u) out.push('Wiki marks this unobtainable');
    return out;
  });

  /** Advisory route hint, only ever present when no source could be derived. */
  protected readonly hint = computed(() => this.detail()?.hint ?? null);

  /** Recipes, drops and vendors for this item. */
  protected readonly sources = computed(() => {
    const id = this.numericId();
    return id === null ? null : this.store.sourcesById(id);
  });

  protected readonly crafts = computed(() => this.sources()?.craft ?? []);
  protected readonly drops = computed(() => this.sources()?.drop ?? []);
  protected readonly shops = computed(() => this.sources()?.shop ?? []);

  /**
   * Icon parts for a crafting station.
   *
   * Compound stations ("Work Bench and Ecto Mist") yield more than one part, so
   * the template renders an icon per part rather than one icon per recipe.
   */
  protected stationParts(station: string) {
    return stationPartsOf(station);
  }

  /** True when "By Hand" is the whole station, i.e. no station is needed. */
  protected isByHand(station: string): boolean {
    return station.trim().toLowerCase() === 'by hand';
  }

  /**
   * Difficulty restriction, when the item cannot be obtained on Normal.
   * Derived from drop data — the wiki has no difficulty field on items.
   */
  protected readonly difficulty = computed(() => {
    const diff = this.sources()?.diff;
    return diff ? { tag: diff, label: difficultyLabel(diff) } : null;
  });

  protected readonly hasAcquisitionDetail = computed(
    () => this.crafts().length > 0 || this.drops().length > 0 || this.shops().length > 0,
  );

  /** Weapon/armour style icon per source kind, kept in the template via classes. */

  /**
   * Difficulty names a drop applies to, or `[]` when it applies to all.
   * Empty means "every difficulty", so the template shows no restriction chip.
   */
  protected dropDifficulties(mask: number | undefined): string[] {
    return mask === undefined ? [] : this.store.difficultyNames(mask);
  }

  /**
   * Rate values that are actually present, so the template can skip absent ones.
   *
   * The filter is `typeof value === 'number'` rather than `!== null` on purpose:
   * a key that is *absent* from the JSON reads back as `undefined`, not `null`,
   * so a `!== null` check lets it through and `${undefined}%` renders as
   * "undefined%". Only Master rates are emitted for a Master-only drop, which is
   * exactly when this bites.
   */
  protected rateRows(rates: DropRates | undefined): { mode: string; value: number }[] {
    if (!rates) return [];
    return [
      { mode: 'Normal', value: rates.normal },
      { mode: 'Expert', value: rates.expert },
      { mode: 'Master', value: rates.master },
    ].filter((r): r is { mode: string; value: number } => typeof r.value === 'number');
  }

  /**
   * The rate for one difficulty as display text.
   * A dash means the drop does not occur in that difficulty at all, which is
   * different from the rate being unknown.
   */
  protected rateFor(rows: { mode: string; value: number }[], mode: string): string {
    const row = rows.find((r) => r.mode.toLowerCase() === mode);
    return row ? this.formatRate(row.value) : '—';
  }

  /**
   * Item id for an ingredient name, or `null` for an ingredient group.
   * "Any Wood" and "Any Iron Bar" are groups, not items, so they render as text.
   */
  protected ingredientId(name: string): number | null {
    return this.store.idByName(name);
  }

  protected npcDetail(name: string): { kind: string | null; env: string | null } | null {
    const npc = this.store.npcByName(name);
    return npc ? { kind: npc.kind, env: npc.env } : null;
  }

  protected formatRate(value: number | null | undefined): string {
    // `== null` catches undefined as well as null; a number is required to render.
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return `${value}%`;
  }

  protected formatPrice(copper: number): string {
    return formatCoins(copper);
  }

  protected readonly sprite = computed(() => {
    const item = this.item();
    return item ? spriteUrl(item.name) : '';
  });

  protected badgeClass(source: string): string {
    return SOURCE_BADGE[source] ?? 'badge-ghost';
  }

  /** Hide a sprite that 404s rather than leaving a broken-image glyph. */
  protected onSpriteError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected toggle(): void {
    const item = this.item();
    if (item) this.store.toggleItem(item.id);
  }

  /**
   * Link to the wiki page for this item. The wiki is the authority for anything
   * not in the snapshot, so this is the escape hatch rather than duplicating it.
   */
  protected readonly wikiUrl = computed(() => {
    const item = this.item();
    return item
      ? `https://terraria.wiki.gg/wiki/${encodeURIComponent(item.name.replace(/ /g, '_'))}`
      : null;
  });
}
