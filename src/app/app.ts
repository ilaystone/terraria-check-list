import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { ChecklistStore } from './core/checklist-store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(ChecklistStore);

  /**
   * Percentage of the whole active tier that is ticked.
   *
   * Deliberately not computed from the filtered set: a progress bar that moves
   * when you type a search tells you nothing about how much you have collected.
   */
  protected readonly percent = computed(() => {
    const tierItems = this.store.tierItems();
    const checked = this.store.checkedInTier();
    return tierItems === 0 ? 0 : Math.round((checked / tierItems) * 100);
  });

  /** Whether any progress exists at all, to decide if "reset" is worth offering. */
  protected readonly hasProgress = computed(() => this.store.checkedCount() > 0);

  /**
   * Clearing every tick is destructive and there is no undo, so confirm first.
   * Browser `confirm` is deliberate: this is a rare, high-consequence action and
   * an inline two-step button would need its own state machine.
   */
  protected confirmReset(): void {
    if (confirm(`Untick all ${this.store.checkedCount()} collected items? This cannot be undone.`)) {
      this.store.clearAllProgress();
    }
  }
}
