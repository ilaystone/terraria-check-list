/**
 * Integrity gate.
 *
 * Runs against the emitted files (not the in-memory model) so it validates what
 * the app will actually load. Exits non-zero on any failure, which is what makes
 * regenerating the snapshot safe to do on a whim.
 *
 * Used both by `npm run gather` and standalone as `npm run verify`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ALL_SOURCE_BITS,
  CATEGORY_NAMES,
  ROUTE_TAGS,
  SCHEMA_VERSION,
  SOURCE_FLAGS,
  UNKNOWN_MASK,
  isUnknownMask,
  sourceTagsOf,
} from './schema.mjs';
import { DATA_DIR } from './emit.mjs';

/**
 * @param {{ dataDir?: string }} [opts]
 * @returns {Promise<{ failures: string[], warnings: string[], stats: any }>}
 */
export async function validate({ dataDir = DATA_DIR, minItems = 6000 } = {}) {
  const failures = [];
  const warnings = [];

  const read = async (name) => JSON.parse(await readFile(join(dataDir, name), 'utf8'));
  let index;
  let detail;
  let catalog;
  let sources;
  let refs;
  try {
    [index, detail, catalog, sources, refs] = await Promise.all([
      read('items.index.json'),
      read('items.detail.json'),
      read('catalog.json'),
      read('items.sources.json'),
      read('refs.json'),
    ]);
  } catch (err) {
    return { failures: [`cannot read snapshot: ${err.message}`], warnings, stats: null };
  }

  // --- meta / schema ---
  if (catalog.meta?.schemaVersion !== SCHEMA_VERSION) {
    failures.push(
      `catalog.meta.schemaVersion is ${catalog.meta?.schemaVersion}, expected ${SCHEMA_VERSION}. ` +
        `Bump SCHEMA_VERSION deliberately and migrate stored progress.`,
    );
  }
  if (!Array.isArray(catalog.categories) || catalog.categories.length !== CATEGORY_NAMES.length) {
    failures.push('catalog.categories does not match schema CATEGORY_NAMES');
  }
  if (!Array.isArray(catalog.sourceFlags) || catalog.sourceFlags.join(',') !== SOURCE_FLAGS.join(',')) {
    failures.push('catalog.sourceFlags does not match schema SOURCE_FLAGS');
  }
  if (catalog.sourceFlags && catalog.unknownBit !== (1 << catalog.sourceFlags.indexOf('unknown'))) {
    failures.push('catalog.unknownBit does not match the position of `unknown` in sourceFlags');
  }

  // --- subtypes (optional finer layer) ---
  const subtypes = catalog.subtypes ?? [];
  const seenSubtypeKeys = new Set();
  subtypes.forEach((s, i) => {
    if (!s || typeof s.name !== 'string' || s.name.trim() === '') {
      failures.push(`subtype ${i} has an empty name`);
      return;
    }
    if (!CATEGORY_NAMES.includes(s.parent)) {
      failures.push(`subtype "${s.name}" declares unknown parent "${s.parent}"`);
    }
    const key = `${s.parent}/${s.name.toLowerCase()}`;
    if (seenSubtypeKeys.has(key)) failures.push(`duplicate subtype "${s.name}" under "${s.parent}"`);
    seenSubtypeKeys.add(key);
  });

  // --- index integrity ---
  const seenIds = new Set();
  let curatedCount = 0;
  const bySource = Object.fromEntries(SOURCE_FLAGS.map((f) => [f, 0]));
  const bySourceCombo = {};
  const byCategory = Object.fromEntries(CATEGORY_NAMES.map((c) => [c, 0]));
  const bySubtype = {};
  let subtypedCount = 0;
  let multiRoute = 0;

  for (const item of index) {
    if (!Number.isInteger(item.id) || item.id <= 0) {
      failures.push(`invalid id: ${JSON.stringify(item)}`);
      continue;
    }
    if (seenIds.has(item.id)) {
      failures.push(`duplicate id ${item.id} — progress state keys on id, duplicates corrupt it`);
    }
    seenIds.add(item.id);

    if (typeof item.name !== 'string' || item.name.trim() === '') {
      failures.push(`item ${item.id} has an empty name`);
    }
    if (item.nameLower !== item.name.toLowerCase()) {
      failures.push(`item ${item.id} nameLower does not match name`);
    }
    if (!Number.isInteger(item.categoryIdx) || !CATEGORY_NAMES[item.categoryIdx]) {
      failures.push(`item ${item.id} has out-of-range categoryIdx ${item.categoryIdx}`);
    } else {
      byCategory[CATEGORY_NAMES[item.categoryIdx]] += 1;
    }

    // --- optional subtype ---
    if (item.subIdx !== undefined) {
      if (!Number.isInteger(item.subIdx) || !subtypes[item.subIdx]) {
        failures.push(`item ${item.id} has out-of-range subIdx ${item.subIdx}`);
      } else {
        const st = subtypes[item.subIdx];
        const parent = CATEGORY_NAMES[item.categoryIdx];
        if (st.parent !== parent) {
          failures.push(
            `item ${item.id} is in "${parent}" but its subtype "${st.name}" sits under "${st.parent}"`,
          );
        }
        bySubtype[st.name] = (bySubtype[st.name] ?? 0) + 1;
        subtypedCount += 1;
      }
    }

    // --- source mask ---
    const mask = item.src;
    if (!Number.isInteger(mask) || mask <= 0 || (mask & ~ALL_SOURCE_BITS) !== 0) {
      failures.push(`item ${item.id} has an invalid source mask ${mask}`);
    } else {
      const tags = sourceTagsOf(mask);
      for (const t of tags) bySource[t] += 1;
      bySourceCombo[tags.join('+')] = (bySourceCombo[tags.join('+')] ?? 0) + 1;

      // `unknown` means "no route found" and must never sit alongside a real route.
      if (tags.includes('unknown') && tags.length > 1) {
        failures.push(`item ${item.id} has \`unknown\` combined with other routes: ${tags.join('+')}`);
      }
      if (tags.length > 1 && !tags.includes('unknown')) multiRoute += 1;
    }

    if (item.curated) curatedCount += 1;
  }

  if (index.length < minItems) {
    failures.push(
      `only ${index.length} items emitted (expected at least ${minItems}). ` +
        `A truncated fetch usually means the pipeline was interrupted mid-pagination.`,
    );
  }

  // --- every curated item should be resolvable ---
  const unknownCurated = index.filter((i) => i.curated && i.src === UNKNOWN_MASK);
  if (unknownCurated.length > index.filter((i) => i.curated).length * 0.25) {
    failures.push(
      `${unknownCurated.length} of ${curatedCount} curated items have an unknown source ` +
        `(>25%). The Recipes/Drops join is probably broken, not the wiki.`,
    );
  } else if (unknownCurated.length) {
    warnings.push(`${unknownCurated.length} curated items have an unknown source`);
  }

  // --- detail coverage ---
  const missingDetail = index.filter((i) => !(i.id in detail));
  if (missingDetail.length) {
    failures.push(`${missingDetail.length} items have no detail entry (first: ${missingDetail[0].id})`);
  }
  const orphanDetail = Object.keys(detail).filter((k) => !seenIds.has(Number(k)));
  if (orphanDetail.length) {
    warnings.push(`${orphanDetail.length} detail entries have no matching item`);
  }

  // --- advisory hints must never sit on an item whose routes resolved ---
  const validHints = new Set(ROUTE_TAGS);
  let hintCount = 0;
  let misplacedHints = 0;
  for (const item of index) {
    const hint = detail[item.id]?.hint;
    if (!hint) continue;
    hintCount += 1;
    if (!isUnknownMask(item.src)) misplacedHints += 1;
    if (!validHints.has(hint)) failures.push(`item ${item.id} has unknown source hint "${hint}"`);
  }
  if (misplacedHints) {
    failures.push(
      `${misplacedHints} items carry a source hint but already have a resolved route — ` +
        `the hint is advisory only and must not appear on resolved items`,
    );
  }

  // --- acquisition detail ---
  let craftEntries = 0;
  let dropEntries = 0;
  let shopEntries = 0;
  let difficultyTagged = 0;
  const rateValues = [];
  const validDifficulties = new Set(catalog.difficulties ?? ['normal', 'expert', 'master']);

  for (const [key, entry] of Object.entries(sources)) {
    const id = Number(key);
    if (!seenIds.has(id)) {
      failures.push(`sources entry ${key} has no matching item`);
      continue;
    }
    if (entry.diff) {
      difficultyTagged += 1;
      if (!['expert', 'master', 'expert-master'].includes(entry.diff)) {
        failures.push(`item ${id} has an unknown difficulty tag "${entry.diff}"`);
      }
    }

    for (const craft of entry.craft ?? []) {
      craftEntries += 1;
      if (!craft.st || String(craft.st).trim() === '') {
        failures.push(`item ${id} has a recipe with no crafting station`);
      }
      if (!Array.isArray(craft.ings) || craft.ings.length === 0) {
        failures.push(`item ${id} has a recipe with no ingredients`);
        continue;
      }
      for (const ing of craft.ings) {
        if (!ing || typeof ing.n !== 'string' || ing.n.trim() === '') {
          failures.push(`item ${id} has an ingredient with no name`);
        }
        if (!Number.isInteger(ing.q) || ing.q < 1) {
          failures.push(`item ${id} has ingredient "${ing.n}" with a bad quantity ${ing.q}`);
        }
      }
      // A recipe must not list itself, which would mean the join is wrong.
      const selfName = index.find((i) => i.id === id)?.nameLower;
      if (selfName && craft.ings.some((ing) => String(ing.n).toLowerCase() === selfName)) {
        failures.push(`item ${id} recipe lists itself as an ingredient`);
      }
    }

    for (const drop of entry.drop ?? []) {
      dropEntries += 1;
      if (!drop.s || String(drop.s).trim() === '') {
        failures.push(`item ${id} has a drop with no source name`);
      }
      if (drop.d !== undefined) {
        if (!Number.isInteger(drop.d) || drop.d <= 0 || (drop.d & ~7) !== 0) {
          failures.push(`item ${id} has an out-of-range drop difficulty mask ${drop.d}`);
        }
      }
      if (drop.r) {
        for (const [mode, value] of Object.entries(drop.r)) {
          if (!validDifficulties.has(mode)) {
            failures.push(`item ${id} has a rate for unknown difficulty "${mode}"`);
          }
          if (value === null) continue;
          rateValues.push(value);
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
            failures.push(`item ${id} has an impossible drop rate ${value}% from "${drop.s}"`);
          }
        }
      }
    }

    for (const shop of entry.shop ?? []) {
      shopEntries += 1;
      if (!shop.npc || !Number.isInteger(shop.price) || shop.price <= 0) {
        failures.push(`item ${id} has an invalid vendor entry`);
      }
    }
  }

  // --- refs ---
  const npcs = refs.npcs ?? {};
  if (Object.keys(npcs).length === 0) {
    failures.push('refs.npcs is empty — drop sources would have no enemy names to resolve to');
  }

  const stats = {
    items: index.length,
    curated: curatedCount,
    detailEntries: Object.keys(detail).length,
    hints: hintCount,
    multiRoute,
    subtyped: subtypedCount,
    subtypes: subtypes.length,
    sourcesEntries: Object.keys(sources).length,
    craftEntries,
    dropEntries,
    shopEntries,
    difficultyTagged,
    npcNames: Object.keys(npcs).length,
    bySource,
    bySourceCombo,
    bySubtype,
    byCategory,
    generatedAt: catalog.meta?.generatedAt,
  };

  return { failures, warnings, stats };
}

// Standalone CLI: `npm run verify`. Guarded on the real entry path so importing
// this module from gather.mjs never triggers it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, warnings, stats } = await validate();
  for (const w of warnings) console.warn(`WARN ${w}`);
  if (failures.length) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(
    `OK  items=${stats.items} curated=${stats.curated} detail=${stats.detailEntries} ` +
      `hints=${stats.hints} multiRoute=${stats.multiRoute} subtyped=${stats.subtyped}/${stats.items}`,
  );
  console.log(`    generated ${stats.generatedAt}`);
  console.log('    tags (an item can carry several, so these sum above the item count):');
  for (const [k, v] of Object.entries(stats.bySource)) console.log(`      ${k.padEnd(8)} ${String(v).padStart(5)}`);
  if (stats.subtypes) {
    console.log(`    subtypes (${stats.subtypes} defined, ${Object.keys(stats.bySubtype).length} in use):`);
    for (const [k, v] of Object.entries(stats.bySubtype).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${k.padEnd(16)} ${String(v).padStart(5)}`);
    }
  }
  console.log('    most common tag combinations:');
  for (const [combo, n] of Object.entries(stats.bySourceCombo).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`      ${combo.padEnd(24)} ${String(n).padStart(5)}`);
  }
}
