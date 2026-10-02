import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ChecklistStore } from '../../core/checklist-store';
import { ItemRow } from './item-row';

@Component({
  selector: 'app-checklist-page',
  imports: [ItemRow],
  templateUrl: './checklist-page.html',
  styleUrl: './checklist-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChecklistPage {
  protected readonly store = inject(ChecklistStore);

  /** True once the snapshot has loaded and the active filters match nothing. */
  protected readonly isEmpty = computed(
    () => this.store.isReady() && this.store.filtered().length === 0,
  );

  /** Used to explain an empty list rather than just showing nothing. */
  protected readonly hasActiveFilters = computed(
    () => this.store.query().length > 0 || this.store.category() !== null || this.store.sourceBits() !== 0,
  );

  protected onSearch(event: Event): void {
    this.store.setQuery((event.target as HTMLInputElement).value);
  }

  /**
   * Whether a source chip is selected.
   *
   * Angular templates have no bitwise operators, so the mask test lives here.
   * Calling this from the template still tracks the `sourceBits` signal, because
   * the signal read happens inside the call.
   */
  protected isSourceActive(bitIndex: number): boolean {
    return (this.store.sourceBits() & (1 << bitIndex)) !== 0;
  }

  protected onTierChange(tier: 'curated' | 'all'): void {
    this.store.setTier(tier);
  }

  protected toggleAll(): void {
    // Tri-state: if anything is ticked, this clears; otherwise it ticks everything.
    if (this.store.tierSelectionState() === 'none') this.store.checkAll('filtered');
    else this.store.uncheckAll('filtered');
  }
}
