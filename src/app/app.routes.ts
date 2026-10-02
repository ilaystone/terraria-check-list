import { Routes } from '@angular/router';

/**
 * Feature routes are lazy so the initial bundle stays small. The snapshot itself
 * is loaded by the shell (the progress meter needs the totals on every route),
 * so lazy loading here splits component code, not data.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Terraria Checklist',
    loadComponent: () => import('./features/checklist/checklist-page').then((m) => m.ChecklistPage),
  },
  {
    path: 'item/:id',
    title: 'Item — Terraria Checklist',
    loadComponent: () => import('./features/item/item-detail-page').then((m) => m.ItemDetailPage),
  },
  { path: '**', redirectTo: '' },
];
