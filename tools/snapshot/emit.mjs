/**
 * Stage 3 — emit.
 *
 * Writes the committed snapshot into public/data/. Writes are atomic (tmp +
 * rename) so an interrupted gather can never leave a half-written snapshot that
 * the app would happily parse as empty.
 *
 * Payload split is deliberate:
 *   items.index.json   everything the list view touches on every row
 *   items.detail.json  market/research stats, shown only on one item's page
 *   catalog.json       categories, sources, meta — tiny, referenced by both
 *
 * Diagnostics are written to .cache/, never shipped.
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { DIFFICULTIES, DIFFICULTY_BITS, DIFFICULTY_MASK_ALL as ALL_DIFFICULTIES } from './schema-difficulty.mjs';

export const DATA_DIR = 'public/data';
export const CACHE_DIR = '.cache/snapshot';

async function writeAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/**
 * @param {{ snapshot: any, logger: any }} opts
 * @returns {Promise<{ files: {path: string, bytes: number}[], snapshot: any }>}
 */
export async function emit({ snapshot, logger }) {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const index = snapshot.records.map((r) => {
    const entry = {
      id: r.id,
      name: r.name,
      nameLower: r.nameLower,
      categoryIdx: r.categoryIdx,
      /** bitmask over catalog.sourceFlags: bit i => sourceFlags[i] */
      src: r.sourceMask,
      curated: r.curated,
    };
    // Optional finer layer; omitted entirely when the item has no subtype, which
    // is the common case and keeps 5789 of 6140 rows byte-identical to before.
    if (r.subIdx >= 0) entry.subIdx = r.subIdx;
    return entry;
  });

  const detail = {};
  for (const r of snapshot.records) {
    const d = r._detail;
    const entry = {};
    if (d.research) entry.r = d.research;
    if (d.stack) entry.s = d.stack;
    if (d.buy !== null) entry.b = d.buy;
    if (d.sell !== null) entry.sl = d.sell;
    if (d.placeable) entry.p = 1;
    if (d.consumable) entry.c = 1;
    if (d.hardmode) entry.h = 1;
    if (d.unobtainable) entry.u = 1;
    if (r.sourceHint) entry.hint = r.sourceHint;
    if (r._tags.length) entry.t = r._tags;
    detail[r.id] = entry;
  }

  /**
   * Full acquisition detail, only for items that have any.
   *
   * Kept out of `items.detail.json` because it is an order of magnitude larger
   * and only needed on one item's page; and kept out of the index because the
   * list view never shows a recipe.
   */
  const sources = {};
  for (const r of snapshot.records) {
    const s = r.sources;
    const has = s.crafts.length > 0 || s.drops.length > 0 || s.shops.length > 0;
    if (!has && !r.difficulty) continue;

    const entry = {};
    if (s.crafts.length) {
      entry.craft = s.crafts.map((c) => {
        const out = { st: c.station, ings: c.ings };
        if (c.amount > 1) out.n = c.amount;
        return out;
      });
    }
    if (s.drops.length) {
      entry.drop = s.drops.map((d) => {
        const out = { s: d.s, q: d.q };
        // Only record the mode flags when they are not "every difficulty".
        if (d.d !== ALL_DIFFICULTIES) out.d = d.d;
        if (d.r) {
          // A rate is only meaningful in a difficulty the drop exists in. The
          // parser inherits neighbouring values to fill gaps, which would
          // otherwise report a Treasure Bag's Expert rate as a Normal rate —
          // impossible, since treasure bags do not exist on Normal.
          const usable = d.d === 0 ? ALL_DIFFICULTIES : d.d;
          const rates = {};
          if (usable & DIFFICULTY_BITS.normal) rates.normal = d.r.normal;
          if (usable & DIFFICULTY_BITS.expert) rates.expert = d.r.expert;
          if (usable & DIFFICULTY_BITS.master) rates.master = d.r.master;
          if (Object.values(rates).some((v) => v !== null)) out.r = rates;
        }
        return out;
      });
    }
    if (s.shops.length) entry.shop = s.shops;
    if (r.difficulty) entry.diff = r.difficulty;

    sources[r.id] = entry;
  }

  const catalog = {
    meta: snapshot.meta,
    categories: snapshot.categories,
    /** Tag names in bit order: bit (1 << i) means "obtainable via sourceFlags[i]". */
    sourceFlags: snapshot.sourceFlags,
    /** Every flag except `unknown` represents a route; `unknown` is standalone. */
    unknownBit: 1 << snapshot.sourceFlags.indexOf('unknown'),
    /**
     * Optional finer layer. `subIdx` on an item indexes this array. Each subtype
     * declares the category it sits under, so the app can render a two-level
     * tree and treat any item without a subIdx as a direct child of its category.
     */
    subtypes: snapshot.subtypes,
    /**
     * Distinct crafting stations, so the app resolves station icons from data
     * rather than from a hard-coded list that could drift from the wiki.
     */
    stations: snapshot.stations,
    /** Difficulty names in bit order, for the `d` mask on a drop source. */
    difficulties: DIFFICULTIES,
    /** Bit per difficulty, mirrored so the app does not hard-code positions. */
    difficultyBits: DIFFICULTY_BITS,
  };

  /**
   * Enemy and source lookup, kept out of `catalog.json`.
   *
   * `catalog.json` is on the critical path — the shell reads it to render the
   * sidebar and progress meter — so putting ~530 enemies in it bloated it from
   * 1.4 KB to 46 KB for data only the detail page needs.
   */
  const refs = { npcs: snapshot.npcs };

  const payloads = [
    { name: 'items.index.json', data: index },
    { name: 'items.detail.json', data: detail },
    { name: 'items.sources.json', data: sources },
    { name: 'refs.json', data: refs },
    { name: 'catalog.json', data: catalog },
  ];

  const files = [];
  for (const { name, data } of payloads) {
    const text = JSON.stringify(data);
    await writeAtomic(join(DATA_DIR, name), text);
    files.push({ path: join(DATA_DIR, name), bytes: bytes(text) });
  }

  const diagnosticsPath = join(CACHE_DIR, 'diagnostics.json');
  const diagText = JSON.stringify(snapshot.diagnostics, null, 2);
  await writeAtomic(diagnosticsPath, diagText);

  const total = files.reduce((n, f) => n + f.bytes, 0);
  logger.info('emitted:');
  for (const f of files) logger.info(`  ${f.path.padEnd(32)} ${kb(f.bytes)}`);
  logger.info(`  ${'TOTAL'.padEnd(32)} ${kb(total)}`);
  logger.info(`diagnostics -> ${diagnosticsPath} (${kb(bytes(diagText))})`);

  return { files, totalBytes: total, snapshot };
}
