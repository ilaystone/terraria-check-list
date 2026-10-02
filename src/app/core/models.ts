/**
 * Domain models mirroring the generated snapshot in `public/data/`.
 *
 * These types are a contract with `tools/snapshot/`. The generator writes short
 * keys to keep the payload small, so each field below documents its snapshot
 * name — if the generator changes a key, this file must change with it.
 */

/** One row of `items.index.json`. */
export interface ItemIndexRow {
  /** `id` — stable item id. Progress state keys on this and nothing else. */
  readonly id: number;
  /** `name` — display name, e.g. "Terra Blade". */
  readonly name: string;
  /** `nameLower` — precomputed for case-insensitive search. */
  readonly nameLower: string;
  /** `categoryIdx` — index into `catalog.categories`. */
  readonly categoryIdx: number;
  /** `src` — bitmask over `catalog.sourceFlags`. An item usually has several. */
  readonly src: number;
  /** `curated` — true for the default tier; false for the extended tier. */
  readonly curated: boolean;
  /** `subIdx` — optional index into `catalog.subtypes`. Absent when the item has no finer kind. */
  readonly subIdx?: number;
}

/**
 * One entry of `items.detail.json`, keyed by item id.
 *
 * Every field is optional: the generator omits falsy values so that 6,140
 * records stay compact.
 */
export interface ItemDetail {
  /** `r` — research cost (Journey Mode). */
  readonly r?: string;
  /** `s` — max stack size. */
  readonly s?: string;
  /** `b` — buy price in copper. */
  readonly b?: number;
  /** `sl` — sell price in copper. */
  readonly sl?: number;
  /** `p` — placeable. */
  readonly p?: number;
  /** `c` — consumable. */
  readonly c?: number;
  /** `h` — hardmode-only. */
  readonly h?: number;
  /** `u` — flagged unobtainable by the wiki. */
  readonly u?: number;
  /** `t` — raw wiki tags, lowercase. */
  readonly t?: readonly string[];
  /**
   * `hint` — advisory route from a wiki tag, present ONLY when no route could be
   * derived. It is a weaker claim than a source flag: the flag comes from the
   * Recipes/Drops/buy tables, a hint is an unverified tag on the item page.
   */
  readonly hint?: string;
}

/** One entry of `catalog.subtypes`. */
export interface SubtypeEntry {
  readonly name: string;
  /** The category this subtype sits under. Only "Weapons" exists today. */
  readonly parent: string;
}

/**
 * A drop rate per difficulty. `null` means the drop does not occur in that
 * difficulty — which is different from an unknown rate, and is why these are
 * nullable rather than defaulted to zero.
 */
export interface DropRates {
  readonly normal: number | null;
  readonly expert: number | null;
  readonly master: number | null;
}

/** One craft route from `items.sources.json`. */
export interface CraftSource {
  /** Crafting station, e.g. "Mythril Anvil". "By Hand" means no station. */
  readonly st: string;
  /** Ingredients. Names may be groups ("Any Wood") that are not items. */
  readonly ings: readonly { readonly n: string; readonly q: number }[];
  /** Output count, present only when the recipe yields more than one. */
  readonly n?: number;
}

/** One drop route. */
export interface DropSource {
  /** Source name: an enemy, a crate, or a chest. */
  readonly s: string;
  /** Quantity as the wiki states it, e.g. "1" or "5–10". */
  readonly q: string;
  /** Difficulty bitmask. Absent means every difficulty. */
  readonly d?: number;
  /** Rate per difficulty. Absent when the wiki states no numeric rate. */
  readonly r?: DropRates;
}

/** One vendor route. */
export interface ShopSource {
  readonly npc: string;
  /** Price in copper. */
  readonly price: number;
}

/** `items.sources.json`, per item. */
export interface ItemSources {
  readonly craft?: readonly CraftSource[];
  readonly drop?: readonly DropSource[];
  readonly shop?: readonly ShopSource[];
  /** Set when the item is unobtainable on Normal, e.g. "expert-master". */
  readonly diff?: string;
}

/** One enemy from `refs.json`. */
export interface NpcRef {
  readonly name: string;
  readonly id: number | null;
  readonly kind: string | null;
  readonly env: string | null;
}

/** `refs.json`. */
export interface Refs {
  readonly npcs: Readonly<Record<string, NpcRef>>;
}

export interface SnapshotMeta {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly wikiApi?: string;
  readonly wikiRevision?: { page: string; revid: number; timestamp: string } | null;
  readonly sourceTables?: Readonly<Record<string, number>>;
  readonly sourceHashes?: Readonly<Record<string, string>>;
}

/** `catalog.json`. */
export interface Catalog {
  readonly meta: SnapshotMeta;
  /** Category names; `ItemIndexRow.categoryIdx` indexes this. */
  readonly categories: readonly string[];
  /** Source tag names; bit `1 << i` in `ItemIndexRow.src` means this tag applies. */
  readonly sourceFlags: readonly string[];
  /** Convenience: the bit meaning "no route found". Never combined with other bits. */
  readonly unknownBit: number;
  /** Optional finer layer. Absent in snapshots older than schema v3. */
  readonly subtypes?: readonly SubtypeEntry[];
  /** Difficulty names in bit order, for a drop source's `d` mask. */
  readonly difficulties?: readonly string[];
  readonly difficultyBits?: Readonly<Record<string, number>>;
}

/** Difficulty names set in a drop's mask, given the catalog's bit positions. */
export function difficultiesOf(
  mask: number | undefined,
  names: readonly string[],
  bits: Readonly<Record<string, number>> | undefined,
): string[] {
  if (mask === undefined) return [];
  return names.filter((n) => ((bits?.[n] ?? 1 << names.indexOf(n)) & mask) !== 0);
}

/** Human-readable label for a difficulty tag from `ItemSources.diff`. */
export function difficultyLabel(diff: string | undefined): string | null {
  switch (diff) {
    case 'expert':
      return 'Expert Mode only';
    case 'master':
      return 'Master Mode only';
    case 'expert-master':
      return 'Expert & Master only';
    default:
      return null;
  }
}

/** The three payloads, loaded together. */
export interface Snapshot {
  readonly catalog: Catalog;
  readonly items: readonly ItemIndexRow[];
  readonly details: Readonly<Record<string, ItemDetail>>;
}

/** True when `mask` has the bit at `bitIndex` set. */
export function hasSource(mask: number, bitIndex: number): boolean {
  return (mask & (1 << bitIndex)) !== 0;
}

/** Names of every source tag set in `mask`, in catalog order. */
export function sourceNames(mask: number, sourceFlags: readonly string[]): string[] {
  return sourceFlags.filter((_, i) => hasSource(mask, i));
}

/**
 * Copper to a Terraria-style coin string ("1 Gold 50 Silver").
 * Values under 100 copper omit the coin name, matching the game's display.
 */
export function formatCoins(copper: number | undefined): string {
  if (copper === undefined || copper <= 0) return '—';
  const units: readonly [number, string][] = [
    [1_000_000, 'Platinum'],
    [10_000, 'Gold'],
    [100, 'Silver'],
    [1, 'Copper'],
  ];
  const parts: string[] = [];
  let left = copper;
  for (const [value, label] of units) {
    const count = Math.floor(left / value);
    if (count > 0) {
      parts.push(label === 'Copper' ? `${count}` : `${count} ${label}`);
      left -= count * value;
    }
  }
  return parts.join(' ');
}

/** Base URL for wiki item sprites. */
const SPRITE_BASE = 'https://terraria.wiki.gg/images/';

/**
 * Percent-encode a wiki filename.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped because they are legal URL
 * sub-delimiters, but they are not legal in a *path segment* without escaping.
 * Terraria item names use several of them — "Betsy's Wrath", "Fish Finder!" —
 * so they are escaped explicitly rather than relying on the server tolerating it.
 * (Verified: the wiki serves both forms, but only one is correct.)
 */
function encodeFileName(file: string): string {
  return encodeURIComponent(file).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * URL of an item's sprite on the wiki.
 *
 * The wiki stores item images under the item's display name with spaces replaced
 * by underscores — `Module:Iteminfo` and the `Imageinfo` table both use that form
 * ("Terra Blade.png"). This is derived rather than snapshotted: adding every
 * filename to the snapshot would grow it for data the browser can address
 * directly, and a missing sprite degrades to a hidden image on `error`.
 *
 * Measured on a sample: 13 of 14 well-known items resolve. A handful do not
 * (Fallen Star is stored under a different name), which is exactly why the
 * template handles the error event rather than trusting this blindly.
 *
 * IMPORTANT: the wiki blocks hotlinking by `Referer` — a request carrying a
 * `Referer` from another origin gets HTTP 403 while the same request with no
 * referer gets 200. Every `<img>` using this URL must therefore set
 * `referrerpolicy="no-referrer"`, or the sprite silently fails to load. (A
 * Node-side probe will not reveal this, because `fetch` sends no referer.)
 */
export function spriteUrl(name: string): string {
  return `${SPRITE_BASE}${encodeFileName(name.replace(/ /g, '_'))}.png`;
}
