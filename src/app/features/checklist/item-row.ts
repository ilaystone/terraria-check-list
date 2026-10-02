import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ChecklistStore } from '../../core/checklist-store';
import { sourceNames, spriteUrl, type ItemIndexRow } from '../../core/models';

/** Maps a source tag to its daisyUI badge colour. */
const SOURCE_BADGE: Record<string, string> = {
  craft: 'badge-success',
  drop: 'badge-warning',
  shop: 'badge-info',
  fished: 'badge-accent',
  unknown: 'badge-ghost',
};

/**
 * One item row.
 *
 * The selector is an element, not `tr[app-item-row]`. A component selector that
 * *is* a `<tr>` does not work: Angular still wraps the component in its own
 * host element, producing `<tr><tr>…</tr></tr>`. That is invalid table markup —
 * the browser reparents the cells and the columns collapse — and it silently
 * doubles the rendered row count. So this component renders its own `<tr>` and
 * the parent simply places `<app-item-row>` inside `<tbody>`.
 *
 * Presentational: it reads state from the store and delegates the toggle back,
 * so a row never owns a copy of "am I checked" that could drift from the set.
 */
@Component({
  selector: 'app-item-row',
  imports: [RouterLink],
  templateUrl: './item-row.html',
  styleUrl: './item-row.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemRow {
  private readonly store = inject(ChecklistStore);

  readonly item = input.required<ItemIndexRow>();

  protected readonly checked = computed(() => this.store.isChecked(this.item().id));

  protected readonly categoryName = computed(
    () => this.store.categories()[this.item().categoryIdx] ?? '',
  );

  /** Finer kind, when the snapshot provides one (weapons only today). */
  protected readonly subtypeName = computed(() => {
    const subIdx = this.item().subIdx;
    return subIdx === undefined ? null : (this.store.subtypes()[subIdx]?.name ?? null);
  });

  /**
   * Every route this item can be obtained by, in catalog order.
   *
   * An item usually has more than one — Torch is craftable, droppable and
   * purchasable — so this renders a badge per route rather than a single value.
   */
  protected readonly sources = computed(() => sourceNames(this.item().src, this.store.sourceFlags()));

  protected readonly sprite = computed(() => spriteUrl(this.item().name));

  protected badgeClass(source: string): string {
    return SOURCE_BADGE[source] ?? 'badge-ghost';
  }

  /** Hide a sprite that 404s rather than leaving a broken-image glyph. */
  protected onSpriteError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected toggle(): void {
    this.store.toggleItem(this.item().id);
  }
}
