#!/usr/bin/env node
/**
 * `npm run gather` — regenerate the committed wiki snapshot.
 *
 *   fetch (cached)  ->  normalize  ->  emit  ->  validate
 *
 * Flags:
 *   --refresh   ignore the local cache and re-fetch every table from the wiki
 *   --offline   never touch the network; fail if a table is not cached
 *   --skip-fetch use whatever is cached without any freshness check
 *   --check     re-probe table schemas and report drift, change nothing
 *   --quiet     only warnings and errors
 *   --rebuild   re-run normalize+emit+validate from cache, no wiki traffic
 *
 * Exit codes: 0 ok, 1 pipeline/validation failure, 2 bad usage.
 */

import { createLogger, WikiClient } from './wiki-client.mjs';
import { loadTable, checkDrift, wikiRevision } from './fetch.mjs';
import { normalize, readCuration } from './normalize.mjs';
import { emit } from './emit.mjs';
import { validate } from './validate.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

if (has('--help') || has('-h')) {
  console.log(
    [
      'Usage: node tools/snapshot/gather.mjs [options]',
      '',
      '  --refresh    re-fetch all tables from the wiki (slow, polite)',
      '  --offline    never touch the network',
      '  --skip-fetch use cache as-is without drift checks',
      '  --check      report schema drift, change nothing',
      '  --quiet      suppress progress output',
      '  --rebuild    re-derive from cache without touching the wiki',
    ].join('\n'),
  );
  process.exit(0);
}

const known = new Set(['--refresh', '--offline', '--skip-fetch', '--check', '--quiet', '--rebuild']);
const unknownFlags = argv.filter((a) => a.startsWith('-') && !known.has(a));
if (unknownFlags.length) {
  console.error(`Unknown flag(s): ${unknownFlags.join(', ')}. Try --help.`);
  process.exit(2);
}

const logger = createLogger(has('--quiet'));
const offline = has('--offline') || has('--rebuild') || has('--skip-fetch');

async function main() {
  logger.info(`Terraria checklist snapshot — schema v${SCHEMA_VERSION}`);

  const client = new WikiClient({ logger });

  if (has('--check')) {
    logger.info('check mode: reporting drift against .cache/snapshot, changing nothing');
    const findings = await checkDrift({ client, logger });
    const bad = findings.filter((f) => f.status !== 'ok');
    if (bad.length) {
      logger.warn(`${bad.length} table(s) need attention:`);
      for (const f of bad) logger.warn(`  ${f.table}: ${f.status}${f.missingFields?.length ? ` (missing ${f.missingFields.join(', ')})` : ''}`);
      process.exit(1);
    }
    logger.info('all cached tables look current');
    return;
  }

  // --- stage 1: fetch (cached unless --refresh) ---
  const items = await loadTable({ client, key: 'items', refresh: has('--refresh'), offline, logger });
  const recipes = await loadTable({ client, key: 'recipes', refresh: has('--refresh'), offline, logger });
  const drops = await loadTable({ client, key: 'drops', refresh: has('--refresh'), offline, logger });
  const npcs = await loadTable({ client, key: 'npcs', refresh: has('--refresh'), offline, logger });

  const revision = offline ? null : await wikiRevision(client);

  // --- stage 2: normalize ---
  const curation = await readCuration();
  logger.step('normalizing');
  const snapshot = normalize({
    items,
    recipes,
    drops,
    npcs,
    curation,
    meta: {
      wikiApi: 'https://terraria.wiki.gg/api.php',
      wikiRevision: revision,
      sourceTables: {
        items: items.rowCount,
        recipes: recipes.rowCount,
        drops: drops.rowCount,
        npcs: npcs.rowCount,
      },
      sourceHashes: {
        items: items.hash,
        recipes: recipes.hash,
        drops: drops.hash,
        npcs: npcs.hash,
      },
    },
  });

  const c = snapshot.diagnostics.counts;
  logger.info(
    `items=${c.itemsTotal} curated=${c.itemsCurated} unsourced=${c.unsourced} ` +
      `collisions(picked=${c.collisionsPicked}, deduped=${c.collisionsDeduped}) idless=${c.idlessRows}`,
  );
  logger.info(
    `weapons=${c.weapons} withKind=${c.weaponsWithKind} ` +
      `(${((c.weaponsWithKind / Math.max(1, c.weapons)) * 100).toFixed(1)}%) withoutKind=${c.weaponsWithoutKind}`,
  );

  if (Object.keys(snapshot.diagnostics.unmappedTypes).length) {
    const top = Object.entries(snapshot.diagnostics.unmappedTypes).slice(0, 5);
    logger.warn(
      `unmapped wiki type values (${Object.keys(snapshot.diagnostics.unmappedTypes).length}): ` +
        top.map(([t, n]) => `"${t}"x${n}`).join(', '),
    );
  }
  if (snapshot.diagnostics.unmatchedRecipeCount) {
    logger.warn(
      `${snapshot.diagnostics.unmatchedRecipeCount} recipe result name(s) matched no item ` +
        `(first: ${snapshot.diagnostics.unmatchedRecipes.slice(0, 3).join(' | ')})`,
    );
  }

  // --- stage 3: emit ---
  logger.step('emitting');
  await emit({ snapshot, logger });

  // --- gate ---
  logger.step('validating');
  const { failures, warnings, stats } = await validate();

  for (const w of warnings) logger.warn(w);

  if (failures.length) {
    console.error('\nINTEGRITY GATE FAILED — snapshot NOT trusted:');
    for (const f of failures) console.error(`  x ${f}`);
    console.error('\npublic/data/ has been written but should not be committed in this state.');
    process.exit(1);
  }

  logger.info('');
  logger.info(
    `OK  items=${stats.items} curated=${stats.curated} detail=${stats.detailEntries} ` +
      `multiRoute=${stats.multiRoute}`,
  );
  logger.info(
    '    tags (an item can carry several, so these sum above the item count): ' +
      Object.entries(stats.bySource)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
  logger.info(`    generated ${stats.generatedAt}`);
}

main().catch((err) => {
  console.error(`\ngather failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
