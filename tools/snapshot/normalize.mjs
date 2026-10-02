/**
 * Stage 2 — normalize.
 *
 * Pure function of the cached Cargo rows. No network, no filesystem.
 *
 * Responsibilities:
 *   1. Collapse the row-per-page shape into one record per item id.
 *   2. Resolve the nine id collisions between legacy mobile/3DS content and
 *      current content.
 *   3. Assign exactly one category per item (precedence, see schema.mjs).
 *   4. Assign exactly one obtainability flag per item (precedence).
 *   5. Apply tools/snapshot/curation.json to mark the default (curated) tier.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORY_NAMES,
  SCHEMA_VERSION,
  SOURCE_FLAGS,
  WEAPON_KINDS,
  WEAPON_KIND_NAMES,
  classifyListcat,
  deriveRouteHint,
  isTruthyCargo,
  isUnknownMask,
  pickCanonicalRow,
  resolveCategory,
  resolveSourceMask,
  resolveSubtype,
  sourceTagsOf,
  splitList,
} from './schema.mjs';
import {
  deriveDifficultyTag,
  difficultyMaskFromFlags,
  parseDropRates,
} from './schema-difficulty.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function readCuration(path = join(HERE, 'curation.json')) {
  const curation = JSON.parse(await readFile(path, 'utf8'));
  const known = new Set(CATEGORY_NAMES);
  const unknown = [...(curation.includeCategories ?? []), ...(curation.extraCategories ?? [])].filter(
    (c) => !known.has(c),
  );
  if (unknown.length) {
    throw new Error(
      `curation.json references unknown categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}\n` +
        `Valid categories: ${CATEGORY_NAMES.join(', ')}`,
    );
  }
  return curation;
}

/** Collapse runs of whitespace and strip control characters from Cargo text. */
function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `buy` and `sell` both arrive as rendered coin HTML. Examples:
 *
 *   <span class="coin" data-sort-value="350000" title="35 Gold Coins">…</span>
 *   <span class="coin" data-sort-value="450000" title="45 Defender Medals">…</span>
 *   <span class="i">…File:Magic Hat.png…</span>…<span class="coin"
 *     data-sort-value="36000" …>…</span>&#32;/&#32;<span class="coin"
 *     data-sort-value="32000" …>…</span>
 *
 * So: take the FIRST `data-sort-value` (already in copper) and never parse the
 * visible text. Doing `Number(clean(html))` yields NaN for every single row —
 * that mistake silently produced a `shop=0` count, which is impossible for a
 * game with vendors.
 *
 * Items priced in a non-coin currency (Defender Medals, and similar) are NOT
 * coin purchases and are rejected here. Multi-variant rows ("A / B" with two
 * prices) keep the first price; `variants` in diagnostics reports how many.
 */
function parseCoin(html) {
  if (!html) return null;
  const text = String(html);
  const m = /data-sort-value="(\d+)"/.exec(text);
  if (!m) return null;

  // Non-coin currency check: the title attribute carries the human-readable unit.
  const title = /title="([^"]*)"/.exec(text)?.[1] ?? '';
  if (/medal/i.test(title)) return null;

  return Number(m[1]);
}

/** Cargo integers arrive as strings and are sometimes empty. */
function toPositiveInt(value, fallback) {
  const n = Number(clean(value));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse a recipe's ingredients.
 *
 * `ings` is the field with quantities: `¦Broken Hero Sword¦1^¦True Excalibur¦1`.
 * `ingredients` is the same names *without* quantities, kept as a fallback for
 * rows where `ings` is empty. Entry names are separated by `¦` and entries by
 * `^`, which is why the split leaves empty strings to filter out.
 *
 * Some names are ingredient groups rather than items — "Any Wood", "Any Iron
 * Bar" — so a caller must not assume every name resolves to an item id.
 *
 * @param {string} ings
 * @param {string} ingredients
 * @returns {{ n: string, q: number }[]}
 */
function parseIngredients(ings, ingredients) {
  const parse = (raw) =>
    String(raw ?? '')
      .split('^')
      .map((chunk) => chunk.split('¦').map((s) => s.trim()).filter(Boolean))
      .filter((parts) => parts.length > 0)
      .map((parts) => {
        const q = parts.length > 1 ? toPositiveInt(parts[1], 1) : 1;
        return { n: parts[0], q };
      });

  const withQty = parse(ings);
  if (withQty.length > 0) return withQty;
  return parse(ingredients).map((i) => ({ ...i, q: 1 }));
}

/**
 * @param {{ items: {rows: any[]}, recipes: {rows: any[]}, drops: {rows: any[]},
 *           npcs: {rows: any[]}, curation: any, meta: any }} input
 */
export function normalize({ items, recipes, drops, npcs, curation, meta }) {
  const include = new Set(curation.includeCategories ?? []);
  const extras = new Set(curation.extraCategories ?? []);
  const extraItems = new Set((curation.extraItems ?? []).map(Number));
  const excludeItems = new Set((curation.excludeItems ?? []).map(Number));

  // --- membership sets: presence is all we need, never the graph ---
  const craftable = new Set();
  for (const r of recipes.rows) {
    const name = clean(r.result);
    if (name) craftable.add(name.toLowerCase());
  }
  const dropped = new Set();
  for (const r of drops.rows) {
    const name = clean(r.item);
    if (name) dropped.add(name.toLowerCase());
  }

  /**
   * Full acquisition detail, keyed by lowercase item name during the build and
   * re-keyed by item id when a record is emitted.
   *
   * These are built from the same rows as the membership sets above, so the
   * flags and the detail can never disagree about whether an item is craftable.
   */
  const craftByName = new Map();
  for (const r of recipes.rows) {
    const name = clean(r.result);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!craftByName.has(key)) craftByName.set(key, []);
    const list = craftByName.get(key);
    const entry = {
      station: clean(r.station) || 'By Hand',
      amount: toPositiveInt(r.amount, 1),
      ings: parseIngredients(r.ings, r.ingredients),
    };
    // `Recipes` can hold duplicate rows for one result (version variants).
    const signature = `${entry.station}|${entry.ings.map((i) => `${i.n}x${i.q}`).join(',')}`;
    if (!list.some((e) => e.signature === signature)) {
      list.push({ signature, ...entry });
    }
  }
  for (const list of craftByName.values()) for (const e of list) delete e.signature;

  const dropByName = new Map();
  for (const r of drops.rows) {
    const name = clean(r.item);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!dropByName.has(key)) dropByName.set(key, []);
    const rates = parseDropRates(r.rate);
    const mask = difficultyMaskFromFlags(r.normal, r.expert, r.master);
    // Qualifiers like "(bonus drop)" are not part of the source's name and would
    // break the NPCs lookup. Other parentheses are kept: "Treasure Bag (Eye of
    // Cthulhu)" is the actual name, and stripping the parenthetical collapsed
    // every boss's treasure bag into one meaningless "Treasure Bag".
    const source = clean(r.nameraw).replace(/\s*\(bonus drop\)\s*$/i, '');
    if (!source) continue;
    const entry = {
      s: source,
      q: clean(r.quantity) || '1',
      d: mask,
      r: rates,
    };
    const signature = `${entry.s}|${entry.q}|${entry.d}`;
    const list = dropByName.get(key);
    if (!list.some((e) => e.signature === signature)) {
      list.push({ signature, ...entry });
    }
  }
  for (const list of dropByName.values()) for (const e of list) delete e.signature;

  /**
   * Enemy lookup by raw name. `NPCs.name` is HTML while `Drops.nameraw` matches
   * `NPCs.nameraw` exactly, so that is the join key. Non-enemy sources (crates,
   * chests) simply have no entry and are displayed by name alone.
   */
  const npcByRawName = new Map();
  for (const r of npcs.rows) {
    const raw = clean(r.nameraw);
    if (!raw) continue;
    const id = Number(clean(r.npcid));
    npcByRawName.set(raw, {
      name: raw,
      id: Number.isInteger(id) ? id : null,
      // `type` and `environment` are cheap and useful for "where do I find it".
      kind: clean(r.type) || null,
      env: clean(r.environment) || null,
    });
  }

  // --- group rows by item id ---
  /** @type {Map<number, any[]>} */
  const byId = new Map();
  const idless = [];
  for (const row of items.rows) {
    const raw = clean(row.itemid);
    if (raw === '') {
      idless.push(clean(row.name));
      continue;
    }
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }

  const collisions = [];
  const records = [];
  const unmappedTypes = new Map();

  for (const [id, rows] of byId) {
    if (excludeItems.has(id)) continue;

    let row = rows[0];
    if (rows.length > 1) {
      const names = new Set(rows.map((r) => clean(r.name)));
      if (names.size > 1) {
        // Same id, genuinely different items: pick the live one.
        const winner = pickCanonicalRow(rows);
        row = rows[winner];
        collisions.push({
          id,
          action: 'picked',
          picked: clean(row.name),
          rejected: rows.filter((_, i) => i !== winner).map((r) => clean(r.name)),
        });
      } else {
        // Same item repeated (Cargo artifact): harmless, just dedupe.
        collisions.push({ id, action: 'deduped', picked: clean(row.name), rejected: [] });
      }
    }

    const name = clean(row.name);
    if (!name) continue;

    const { category, categoryIdx, unmapped } = resolveCategory(row);
    for (const t of unmapped) unmappedTypes.set(t, (unmappedTypes.get(t) ?? 0) + 1);

    // Optional finer layer. Only Weapons has one today, and only when listcat
    // names a kind we trust; otherwise the item keeps its parent category.
    const subIdx = resolveSubtype({ listcat: row.listcat, category });
    const { ignored: ignoredListcatValues } = classifyListcat(row.listcat);

    const lower = name.toLowerCase();
    const buy = parseCoin(row.buy);
    const tags = splitList(row.tag).map((t) => t.toLowerCase());

    const sourceMask = resolveSourceMask({
      craftable: craftable.has(lower),
      fished: tags.includes('fished'),
      dropped: dropped.has(lower),
      purchasable: buy !== null,
    });

    // Advisory only, and only when no route was found at all. A tag asserts one
    // route; the mask asserts every route we could derive. Overloading the mask
    // with tag-only claims would mix two different confidence levels in one
    // field.
    const sourceHint = isUnknownMask(sourceMask) ? deriveRouteHint(tags) : null;

    const curated = include.has(category) || extraItems.has(id);

    // --- full acquisition detail ---
    const crafts = craftByName.get(lower) ?? [];
    const dropEntries = dropByName.get(lower) ?? [];

    // Vendors come from tags, which is where the wiki records who sells an item.
    const shops =
      buy === null
        ? []
        : [...new Set(tags.filter((t) => t.startsWith('vendor:')).map((t) => clean(t.slice(7))))]
            .filter(Boolean)
            .map((npc) => ({ npc, price: buy }));

    const difficulty = deriveDifficultyTag(dropEntries.map((d) => d.d));

    records.push({
      id,
      name,
      nameLower: lower,
      categoryIdx,
      subIdx,
      sourceMask,
      curated,
      /** advisory route hint from wiki tags; null when the mask found a route */
      sourceHint,
      /** derived difficulty when the item is not obtainable on Normal, else null */
      difficulty,
      /** full acquisition detail; empty arrays are stripped at emit time */
      sources: { crafts, drops: dropEntries, shops },
      /** diagnostics only — stripped from the shipped payload */
      _tags: tags,
      _ignoredListcat: ignoredListcatValues,
      _detail: {
        research: clean(row.research),
        stack: clean(row.stack),
        buy,
        sell: parseCoin(row.sell),
        placeable: isTruthyCargo(row.placeable),
        consumable: isTruthyCargo(row.consumable),
        hardmode: isTruthyCargo(row.hardmode),
        unobtainable: isTruthyCargo(row.unobtainable),
        internalname:
          clean(row.internalname).toLowerCase() === 'none' ? '' : clean(row.internalname),
      },
    });
  }

  records.sort((a, b) => a.id - b.id);

  // --- diagnostics ---
  // A mask counts in EVERY tag bucket it sets, so these are "items obtainable
  // this way", not "items whose primary route is this". They sum to more than
  // the item count, which is correct and intended.
  const bySource = Object.fromEntries(SOURCE_FLAGS.map((f) => [f, 0]));
  const byCategory = Object.fromEntries(CATEGORY_NAMES.map((c) => [c, 0]));
  const bySourceCombo = {};
  const byHint = {};
  const bySubtype = Object.fromEntries(WEAPON_KIND_NAMES.map((k) => [k, 0]));
  const ignoredListcat = new Map();
  let unsourced = 0;
  let unsourcedExplainedByTag = 0;

  for (const r of records) {
    for (const tag of sourceTagsOf(r.sourceMask)) bySource[tag] += 1;
    byCategory[CATEGORY_NAMES[r.categoryIdx]] += 1;
    if (r.subIdx >= 0) bySubtype[WEAPON_KIND_NAMES[r.subIdx]] += 1;
    for (const v of r._ignoredListcat) ignoredListcat.set(v, (ignoredListcat.get(v) ?? 0) + 1);

    const combo = sourceTagsOf(r.sourceMask).join('+');
    bySourceCombo[combo] = (bySourceCombo[combo] ?? 0) + 1;

    if (isUnknownMask(r.sourceMask)) {
      unsourced += 1;
      if (r.sourceHint) {
        unsourcedExplainedByTag += 1;
        byHint[r.sourceHint] = (byHint[r.sourceHint] ?? 0) + 1;
      }
    }
  }

  const weaponCount = records.filter((r) => CATEGORY_NAMES[r.categoryIdx] === 'Weapons').length;
  const weaponWithKind = records.filter((r) => r.subIdx >= 0).length;

  const curatedUnknown = records.filter(
    (r) => r.curated && isUnknownMask(r.sourceMask),
  ).length;
  const curatedUnknownExplained = records.filter(
    (r) => r.curated && isUnknownMask(r.sourceMask) && r.sourceHint,
  ).length;

  // Recipes/drops whose result names match no item: a silent data-loss signal.
  const itemNames = new Set(records.map((r) => r.nameLower));
  const unmatchedRecipes = new Set();
  for (const r of recipes.rows) {
    const n = clean(r.result).toLowerCase();
    if (n && !itemNames.has(n)) unmatchedRecipes.add(clean(r.result));
  }
  const unmatchedDrops = new Set();
  for (const r of drops.rows) {
    const n = clean(r.item).toLowerCase();
    if (n && !itemNames.has(n)) unmatchedDrops.add(clean(r.item));
  }

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      ...meta,
    },
    categories: CATEGORY_NAMES,
    /** Tag names in bit order; index i corresponds to bit (1 << i). */
    sourceFlags: SOURCE_FLAGS,
    /**
     * Optional finer layer beneath a category. Flat list; `parent` names the
     * category it sits under, so `subIdx` is a lookup into this array.
     */
    subtypes: WEAPON_KINDS.map((k) => ({ name: k.name, parent: k.parent })),
    /** Enemy lookup for drop sources, keyed by raw name. */
    npcs: Object.fromEntries(npcByRawName),
    records,
    diagnostics: {
      counts: {
        itemsTotal: records.length,
        itemsCurated: records.filter((r) => r.curated).length,
        idlessRows: idless.length,
        collisionsPicked: collisions.filter((c) => c.action === 'picked').length,
        collisionsDeduped: collisions.filter((c) => c.action === 'deduped').length,
        unsourced,
        unsourcedExplainedByTag,
        unsourcedUnexplained: unsourced - unsourcedExplainedByTag,
        curatedUnknown,
        curatedUnknownExplained,
        weapons: weaponCount,
        weaponsWithKind: weaponWithKind,
        weaponsWithoutKind: weaponCount - weaponWithKind,
      },
      byCategory,
      bySubtype,
      bySource,
      bySourceCombo,
      byHint,
      ignoredListcat: Object.fromEntries([...ignoredListcat].sort((a, b) => b[1] - a[1])),
      unmappedTypes: Object.fromEntries([...unmappedTypes].sort((a, b) => b[1] - a[1])),
      unmatchedRecipes: [...unmatchedRecipes].slice(0, 50),
      unmatchedRecipeCount: unmatchedRecipes.size,
      unmatchedDropCount: unmatchedDrops.size,
      idlessSamples: idless.slice(0, 20),
      collisions,
    },
  };
}
