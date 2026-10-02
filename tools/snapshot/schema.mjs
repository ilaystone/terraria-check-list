/**
 * The data contract between the snapshot generator and the Angular app.
 *
 * These constants are the single source of truth for:
 *   - which wiki `type`/`tag` values map to which app category
 *   - the precedence used to collapse multi-valued `type` into ONE category
 *   - the precedence used to collapse multiple obtainability routes into ONE flag
 *
 * Both rules are precedence-based on purpose. `type` is NOT a partition:
 * 2442 of 6355 rows carry multiple values (Torch is
 * `furniture^light source^crafting material`). Filtering by "has type X" would
 * place one item in three lists and make every count a lie.
 */

/**
 * Snapshot schema version.
 *
 * 1 -> 2  introduced the curated tier
 * 2 -> 3  replaced the single precedence-ordered `sourceIdx` with the `src`
 *         route bitmask. Any app state persisted against `sourceIdx` must be
 *         migrated or discarded; a stale index silently means a different tag.
 */
export const SCHEMA_VERSION = 3;

/**
 * Canonical category order, highest priority first.
 *
 * Priority matters for genuinely ambiguous items. Kinds an app user thinks of as
 * load-bearing (weapons, armor, accessories) outrank kinds they do not (a torch
 * is a light source, not furniture).
 *
 * `wikiTypes` are matched case-insensitively against `type` values. `wikiTags`
 * are matched lowercased against `tag` values. `category` is the app-facing
 * label and must be unique.
 */
export const CATEGORY_DEFS = [
  { category: 'Weapons', wikiTypes: ['weapon', 'melee', 'ranged', 'magic', 'summon', 'throwing', 'whip'] },
  { category: 'Ammunition', wikiTypes: ['ammunition'] },
  { category: 'Armor sets', wikiTypes: ['set'] },
  { category: 'Armor', wikiTypes: ['armor'] },
  { category: 'Vanity', wikiTypes: ['vanity'], wikiTags: ['vanity'] },
  { category: 'Accessories', wikiTypes: ['accessory', 'shield', 'boots'] },
  { category: 'Tools', wikiTypes: ['tool', 'fishing', 'hook'] },
  { category: 'Mounts', wikiTypes: ['mount summon', 'mount'] },
  { category: 'Pets', wikiTypes: ['pet summon', 'pet', 'light pet'] },
  { category: 'Summon items', wikiTypes: ['boss summon', 'event summon', 'item summon'] },
  { category: 'Potions', wikiTypes: ['potion'] },
  { category: 'Food', wikiTypes: ['food'] },
  { category: 'Dyes', wikiTypes: ['dye', 'hair dye'] },
  { category: 'Consumables', wikiTypes: ['consumable', 'permanent booster'] },
  { category: 'Grab bags', wikiTypes: ['grab bag'] },
  { category: 'Crates', wikiTypes: ['crate'] },
  { category: 'Bait', wikiTypes: ['bait'] },
  { category: 'Seeds', wikiTypes: ['seeds', 'seed'] },
  { category: 'Bars & Ores', wikiTypes: ['ore', 'bar'] },
  { category: 'Gems', wikiTypes: ['gem'] },
  { category: 'Keys', wikiTypes: ['key'] },
  { category: 'Mechanisms', wikiTypes: ['mechanism', 'wire'] },
  { category: 'Light sources', wikiTypes: ['light source'] },
  { category: 'Storage', wikiTypes: ['storage'] },
  { category: 'Crafting stations', wikiTypes: ['crafting station'] },
  { category: 'Materials', wikiTypes: ['crafting material'] },
  { category: 'Blocks', wikiTypes: ['block', 'brick', 'platform'] },
  { category: 'Walls', wikiTypes: ['wall'] },
  { category: 'Furniture', wikiTypes: ['furniture'] },
  { category: 'Statues', wikiTypes: ['statue'] },
  { category: 'Paintings', wikiTypes: ['painting'] },
  { category: 'Banners', wikiTypes: ['banner'] },
  { category: 'Trophies', wikiTypes: ['trophy'] },
  { category: 'Music boxes', wikiTypes: ['music box'] },
  { category: 'Other', wikiTypes: ['miscellaneous', 'background object'] },
];

export const FALLBACK_CATEGORY = 'Uncategorised';

/** Every legal app-facing category label, in priority order. */
export const CATEGORY_NAMES = [...CATEGORY_DEFS.map((d) => d.category), FALLBACK_CATEGORY];

/** Lowercased wiki type -> category index (first definition wins). */
const TYPE_TO_CATEGORY = new Map();
CATEGORY_DEFS.forEach((def, idx) => {
  for (const t of def.wikiTypes) {
    const key = t.toLowerCase();
    if (!TYPE_TO_CATEGORY.has(key)) TYPE_TO_CATEGORY.set(key, idx);
  }
});

/** Lowercased wiki tag -> category index. */
const TAG_TO_CATEGORY = new Map();
CATEGORY_DEFS.forEach((def, idx) => {
  for (const t of def.wikiTags ?? []) {
    const key = t.toLowerCase();
    if (!TAG_TO_CATEGORY.has(key)) TAG_TO_CATEGORY.set(key, idx);
  }
});

/**
 * Cargo returns multi-valued fields as `^`-delimited strings.
 * @param {string|undefined|null} value
 * @returns {string[]}
 */
export function splitList(value) {
  if (!value) return [];
  return String(value)
    .split('^')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve ONE category for an item, by precedence.
 *
 * @param {{ type?: string, tag?: string }} row
 * @returns {{ category: string, categoryIdx: number, unmapped: string[] }}
 */
export function resolveCategory(row) {
  const types = splitList(row.type);
  const tags = splitList(row.tag).map((t) => t.toLowerCase());

  let bestIdx = Number.POSITIVE_INFINITY;
  const unmapped = [];

  for (const t of types) {
    const key = t.toLowerCase();
    const fromTag = TAG_TO_CATEGORY.get(key);
    const idx = TYPE_TO_CATEGORY.get(key) ?? fromTag;
    if (idx === undefined) unmapped.push(t);
    else bestIdx = Math.min(bestIdx, idx);
  }

  // A bare `set` tag marks a set page. It must NOT be able to outrank Weapons,
  // or every weapon-set row would be classified as "Armor sets" and the
  // Weapons count would silently lose entries. Restrict the promotion to rows
  // that are already armor/vanity.
  const armorIdx = CATEGORY_DEFS.findIndex((d) => d.category === 'Armor');
  const vanityIdx = CATEGORY_DEFS.findIndex((d) => d.category === 'Vanity');
  const setIdx = CATEGORY_DEFS.findIndex((d) => d.category === 'Armor sets');
  if (tags.includes('set') && (bestIdx === armorIdx || bestIdx === vanityIdx)) bestIdx = setIdx;

  if (bestIdx === Number.POSITIVE_INFINITY) {
    return {
      category: FALLBACK_CATEGORY,
      categoryIdx: CATEGORY_NAMES.indexOf(FALLBACK_CATEGORY),
      unmapped,
    };
  }

  return {
    category: CATEGORY_NAMES[bestIdx],
    categoryIdx: bestIdx,
    unmapped,
  };
}

/**
 * Obtainability tags.
 *
 * An item is very often obtainable more than one way — Terra Blade is both
 * craftable and a crafting material, Torch is both craftable and purchasable —
 * so this is a SET, not a single value. Each item carries a bitmask of every
 * route that applies, and the app renders one badge per set bit.
 *
 * Order defines bit positions and must stay append-only once a snapshot has
 * shipped: ids are stable, but a bitmask stored in progress data would be
 * silently reinterpreted if positions moved. `unknown` is the only value that
 * means "no route found", and it is never combined with the others.
 */
export const SOURCE_FLAGS = ['craft', 'fished', 'drop', 'shop', 'unknown'];

/** Bit for each tag, keyed by name. */
export const SOURCE_BITS = Object.fromEntries(SOURCE_FLAGS.map((flag, i) => [flag, 1 << i]));

/** Set when no route was found. Never combined with other bits. */
export const UNKNOWN_MASK = SOURCE_BITS.unknown;

export const ALL_SOURCE_BITS = SOURCE_FLAGS.reduce((m, f) => m | SOURCE_BITS[f], 0);

/**
 * Collapse the routes we can derive into a bitmask of tags.
 *
 * There is deliberately no precedence and no "primary route" — that judgement
 * is not in the wiki data, and inventing it would fabricate information. If the
 * UI wants to rank routes, that belongs in the UI.
 *
 * @param {{ craftable: boolean, fished: boolean, dropped: boolean, purchasable: boolean }} routes
 * @returns {number} bitmask over SOURCE_FLAGS
 */
export function resolveSourceMask(routes) {
  let mask = 0;
  if (routes.craftable) mask |= SOURCE_BITS.craft;
  if (routes.fished) mask |= SOURCE_BITS.fished;
  if (routes.dropped) mask |= SOURCE_BITS.drop;
  if (routes.purchasable) mask |= SOURCE_BITS.shop;
  return mask === 0 ? UNKNOWN_MASK : mask;
}

/**
 * Tag names set in a mask, in SOURCE_FLAGS order.
 * @param {number} mask
 * @returns {string[]}
 */
export function sourceTagsOf(mask) {
  return SOURCE_FLAGS.filter((f) => (mask & SOURCE_BITS[f]) !== 0);
}

/** True when the mask carries no route at all. */
export function isUnknownMask(mask) {
  return mask === UNKNOWN_MASK;
}

/**
 * Optional finer layer beneath a category, for weapons only.
 *
 * `listcat` is the only source of a weapon's kind, and it is messy: it mixes
 * kinds (Bows, Guns) with behaviours (`projectile melee`, `wall-piercing
 * weapons`) and unrelated flags (`Scope`, `buffs`, `loot items`, `craftable
 * items`), plus 27 case/whitespace variants of the same value.
 *
 * So this is an explicit ALLOWLIST, not "any non-class listcat value". That
 * distinction is load-bearing: taking every non-class value classified a
 * Flamethrower as a "scope" (28 items carry `Scope`) and would have created
 * categories from acquisition flags.
 *
 * Measured coverage on the 488 weapon-typed items: 351 (71.9%) resolve to one
 * of these 16 kinds, and no item ever carries two kinds, so "first match wins"
 * is unambiguous. The remaining 137 are mostly throwables (Shuriken, Grenade,
 * Throwing Knife) whose listcat never names a kind; they keep their parent
 * category rather than being dumped into an "Other weapons" bucket.
 */
export const WEAPON_KINDS = [
  // melee weapons
  { name: 'Broadswords', parent: 'Weapons' },
  { name: 'Shortswords', parent: 'Weapons' },
  { name: 'Spears', parent: 'Weapons' },
  { name: 'Flails', parent: 'Weapons' },
  { name: 'Yoyos', parent: 'Weapons' },
  { name: 'Boomerangs', parent: 'Weapons' },
  // ranged weapons
  { name: 'Bows', parent: 'Weapons' },
  { name: 'Repeaters', parent: 'Weapons' },
  { name: 'Guns', parent: 'Weapons' },
  { name: 'Launchers', parent: 'Weapons' },
  // magic weapons
  { name: 'Wands', parent: 'Weapons' },
  { name: 'Spell books', parent: 'Weapons' },
  { name: 'Magic guns', parent: 'Weapons' },
  // summon weapons
  { name: 'Whips', parent: 'Weapons' },
  // no usable class in listcat: fold into the parent directly
  { name: 'Explosives', parent: 'Weapons' },
  { name: 'Instruments', parent: 'Weapons' },
];

export const WEAPON_KIND_NAMES = WEAPON_KINDS.map((k) => k.name);

/** Normalised (`lowercased`, whitespace-collapsed) listcat value -> kind index. */
const LISTCAT_TO_KIND = new Map([
  ['broadswords', 0],
  ['shortswords', 1],
  ['spears', 2],
  ['flails', 3],
  ['yoyos', 4],
  ['boomerangs', 5],
  ['bows', 6],
  ['repeaters', 7],
  ['guns', 8],
  ['launchers', 9],
  ['wands', 10],
  ['spell books', 11],
  ['magic guns', 12],
  ['whips', 13],
  ['explosives', 14],
  ['instruments', 15],
]);

/**
 * Subtype index for an item, or -1 when it has none.
 *
 * @param {{ listcat?: string, category?: string }} input
 * @returns {number}
 */
export function resolveSubtype(input) {
  // Subtypes are a weapon-only concept today. Guarding on the parent category
  // stops a stray listcat value from attaching a weapon kind elsewhere.
  if (input.category !== 'Weapons') return -1;
  for (const raw of splitList(input.listcat)) {
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    const idx = LISTCAT_TO_KIND.get(key);
    if (idx !== undefined) return idx;
  }
  return -1;
}

/** Splits listcat values into resolved kinds and everything ignored, for diagnostics. */
export function classifyListcat(listcat) {
  const kinds = [];
  const ignored = [];
  for (const raw of splitList(listcat)) {
    if (raw.includes('|')) {
      ignored.push(raw);
      continue;
    }
    const idx = LISTCAT_TO_KIND.get(raw.toLowerCase().replace(/\s+/g, ' '));
    if (idx === undefined) ignored.push(raw);
    else kinds.push(WEAPON_KIND_NAMES[idx]);
  }
  return { kinds, ignored };
}

/**
 * Decide which of two rows sharing an item id is the live item.
 *
 * Nine ids are shared between legacy mobile/3DS content and current content
 * (5036 = Ocram Trophy AND Otherworldly Music Box (Lunar Boss); 5076 = Red
 * Envelope AND Royal Scepter). The legacy row always carries
 * `internalname = "None"`, so a real internal name wins. Ties fall back to the
 * row not flagged unobtainable.
 *
 * @returns {number} index of the winner within `rows`
 */
export function pickCanonicalRow(rows) {
  const score = (r) => {
    let s = 0;
    const internal = (r.internalname ?? '').trim();
    if (internal && internal.toLowerCase() !== 'none') s += 2;
    if (!isTruthyCargo(r.unobtainable)) s += 1;
    return s;
  };
  let best = 0;
  for (let i = 1; i < rows.length; i++) if (score(rows[i]) > score(rows[best])) best = i;
  return best;
}

/** Cargo `Boolean` fields arrive as '', '0', '1' rather than real booleans. */
export function isTruthyCargo(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
}

/**
 * Wiki `tag` values that name an acquisition route the three Cargo tables do not
 * cover. These are surface-level exclusions (this is not an item, it is where the
 * item comes from) so they carry no precedence between them.
 *
 * Measured on curated items: 284 of the 432 items with no derivable source carry
 * one of these tags. They are emitted as an advisory `hint`, not folded into the
 * hard source flag — a tag is a claim about one route, while the flag answers
 * "what is the primary route", which needs precedence. Keeping them separate
 * avoids inventing a precedence order the wiki never states.
 */
export const ROUTE_TAGS = [
  'treasure bag loot',
  'bag loot',
  'quest rewards',
  'plunder',
  'vendor',
  'drop',
  'loot',
  'buy',
  'buyable',
  'fished',
];

/**
 * Derive an advisory source hint from wiki tags, or null.
 * `vendor:Merchant` collapses to `vendor`.
 *
 * @param {string[]} tags already lowercased
 * @returns {string|null}
 */
export function deriveRouteHint(tags) {
  for (const wanted of ROUTE_TAGS) {
    for (const tag of tags) {
      if (tag === wanted || tag.startsWith(`${wanted}:`)) {
        return wanted === 'vendor' ? 'vendor' : wanted;
      }
    }
  }
  return null;
}
