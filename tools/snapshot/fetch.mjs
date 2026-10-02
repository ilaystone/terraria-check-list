/**
 * Stage 1 — fetch.
 *
 * Pulls the Cargo tables the checklist is derived from and caches them on disk
 * under `.cache/snapshot/`. Normalisation then runs entirely offline, so
 * iterating on category rules costs zero wiki requests.
 *
 * Cargo tables used:
 *   Items   - the item inventory (id, name, wiki type/tag, market data)
 *   Recipes - result -> crafted? (we keep a membership set, not the graph)
 *   Drops   - item   -> dropped? (same: membership only)
 *
 * This is a one-way flow. The app never talks to the wiki at runtime: browser
 * requests cannot set a User-Agent, so they are rate-limited from the first
 * call with no client-side fix.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { WikiClient } from './wiki-client.mjs';

export const CACHE_DIR = '.cache/snapshot';
export const CACHE_FORMAT = 1;

export const TABLES = {
  items: {
    table: 'Items',
    fields:
      'itemid,name,internalname,type,tag,listcat,unobtainable,research,stack,buy,sell,placeable,consumable,hardmode',
  },
  recipes: {
    table: 'Recipes',
    // `ings` carries quantities ("¦Broken Hero Sword¦1"); `ingredients` is the
    // same list without them and is used only as a fallback.
    fields: 'result,resultid,amount,station,ingredients,ings',
  },
  drops: {
    table: 'Drops',
    // `nameraw` is the source (enemy, crate or chest) and the join key into NPCs.
    fields: 'item,nameraw,quantity,rate,isfromnpc,normal,expert,master',
  },
  /**
   * Enemy names, so a drop source can be shown as a readable name with an id
   * rather than raw wikitext. `nameraw` is the join key: `NPCs.name` is HTML and
   * `Drops.nameraw` matches `NPCs.nameraw` exactly.
   */
  npcs: {
    table: 'NPCs',
    fields: 'npcid,nameraw,name,type,environment',
  },
};

/** Stable hash over the rows, so drift detection compares content not timestamps. */
function hashRows(rows) {
  const h = createHash('sha256');
  h.update(JSON.stringify(rows));
  return h.digest('hex').slice(0, 16);
}

async function readCache(key) {
  try {
    const raw = await readFile(join(CACHE_DIR, `${key}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.cacheFormat !== CACHE_FORMAT) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCacheAtomic(key, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  const target = join(CACHE_DIR, `${key}.json`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(payload));
  await rename(tmp, target);
}

/**
 * Load one table: from cache when valid, otherwise from the wiki.
 *
 * @param {{ client: import('./wiki-client.mjs').WikiClient, key: keyof typeof TABLES,
 *           refresh?: boolean, offline?: boolean, logger: any }} opts
 */
export async function loadTable({ client, key, refresh = false, offline = false, logger }) {
  const spec = TABLES[key];
  const cached = await readCache(key);

  // A cache written with an older field list would silently produce empty
  // columns, so treat a field-list change as a cache miss. This bit us once:
  // `ings` and `nameraw` were added to the schema but the cached rows predated
  // them, so every recipe had no ingredients and no item had any drop source.
  const staleFields = cached !== null && cached.fields !== spec.fields;

  if (!refresh && cached && !staleFields) {
    logger.info(`cache hit ${spec.table}: ${cached.rows.length} rows (hash ${cached.hash})`);
    return cached;
  }

  if (staleFields) {
    logger.warn(`${spec.table} cache predates the current field list; re-fetching`);
  }

  if (offline) {
    if (staleFields) {
      throw new Error(
        `${spec.table} cache was fetched with different fields ` +
          `(cached: ${cached.fields}; wanted: ${spec.fields}). ` +
          `Re-run without --offline to refresh it.`,
      );
    }
    throw new Error(
      `--offline was requested but no usable cache exists for ${spec.table}. ` +
        `Run without --offline once to populate ${CACHE_DIR}/.`,
    );
  }

  logger.step(`fetching ${spec.table} from the wiki…`);
  const started = Date.now();
  const rows = await client.cargoQuery({
    tables: spec.table,
    fields: spec.fields,
    onPage: (fetched, batch) => logger.info(`  ${spec.table}: ${fetched} rows (+${batch})`),
  });
  const hash = hashRows(rows);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (cached && cached.hash === hash) {
    logger.info(`${spec.table} unchanged (hash ${hash}) — ${seconds}s`);
  } else if (cached) {
    logger.warn(`${spec.table} CHANGED: ${cached.rows.length} -> ${rows.length} rows, hash ${cached.hash} -> ${hash}`);
  } else {
    logger.info(`${spec.table} fetched: ${rows.length} rows in ${seconds}s`);
  }

  const payload = {
    cacheFormat: CACHE_FORMAT,
    table: spec.table,
    fields: spec.fields,
    fetchedAt: new Date().toISOString(),
    rowCount: rows.length,
    hash,
    rows,
  };
  await writeCacheAtomic(key, payload);
  return payload;
}

/**
 * `--check` mode: re-probe table schemas and report drift against the cache
 * without overwriting it. This is the cheap CI/manual staleness probe.
 */
export async function checkDrift({ client, logger }) {
  const findings = [];

  for (const [key, spec] of Object.entries(TABLES)) {
    const cached = await readCache(key);
    if (!cached) {
      findings.push({ table: spec.table, status: 'no-cache' });
      continue;
    }

    const fields = await client.cargoFields(spec.table);
    const cachedFieldNames = cached.fields.split(',').sort().join(',');
    const liveFieldNames = Object.keys(fields).sort().join(',');

    const missing = cached.fields.split(',').filter((f) => !(f in fields));
    findings.push({
      table: spec.table,
      status: missing.length ? 'schema-drift' : 'ok',
      cachedRows: cached.rows.length,
      cachedAt: cached.fetchedAt,
      missingFields: missing,
      liveFieldCount: Object.keys(fields).length,
      fieldsMatch: cachedFieldNames === liveFieldNames,
    });
    logger.info(
      `${spec.table}: cached ${cached.rows.length} rows from ${cached.fetchedAt}` +
        (missing.length ? ` — MISSING FIELDS: ${missing.join(', ')}` : ' — fields present'),
    );
  }

  return findings;
}

/**
 * Pin the wiki revision the snapshot was taken against. Cargo offers no
 * cross-table snapshot isolation, so a multi-table fetch can straddle an edit;
 * recording the revision makes that detectable rather than mysterious.
 *
 * The page title is discovered from siteinfo rather than hardcoded — a wrong
 * title yields a `missing` page and a meaningless `revid: 0`.
 */
export async function wikiRevision(client) {
  try {
    const page = await client.mainPage();
    if (!page) return null;
    return await client.revisionOf(page);
  } catch {
    return null;
  }
}

export { WikiClient };
