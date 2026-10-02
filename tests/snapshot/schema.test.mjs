/**
 * Tests for the generator's precedence and collision rules.
 *
 * Run with `npm test` (node:test — no test framework dependency, because the
 * code under test is plain ESM and needs no transform).
 *
 * These rules are the only part of the pipeline whose failure is silent: a wrong
 * category or a mis-resolved id collision still produces a plausible-looking
 * snapshot, but corrupts user progress. Everything else either throws or is
 * visible in the emitted JSON.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_SOURCE_BITS,
  CATEGORY_NAMES,
  SCHEMA_VERSION,
  SOURCE_BITS,
  SOURCE_FLAGS,
  UNKNOWN_MASK,
  WEAPON_KINDS,
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
} from '../../tools/snapshot/schema.mjs';
import {
  DIFFICULTY_BITS,
  DIFFICULTY_MASK_ALL,
  deriveDifficultyTag,
  difficultyMaskFromFlags,
  difficultyNames,
  parseDropRates,
} from '../../tools/snapshot/schema-difficulty.mjs';

describe('splitList', () => {
  it('splits the Cargo isList delimiter and trims entries', () => {
    assert.deepEqual(splitList('weapon^crafting material'), ['weapon', 'crafting material']);
    assert.deepEqual(splitList(' vanity ^ set '), ['vanity', 'set']);
  });

  it('treats empty and missing values as no entries', () => {
    assert.deepEqual(splitList(''), []);
    assert.deepEqual(splitList(undefined), []);
    assert.deepEqual(splitList(null), []);
    assert.deepEqual(splitList('^^'), []);
  });
});

describe('resolveCategory', () => {
  it('gives a multi-type item exactly one category', () => {
    // Torch really is furniture^light source^crafting material. Priority must
    // pick light source, not furniture, or "easy to navigate" breaks.
    const { category } = resolveCategory({ type: 'furniture^light source^crafting material' });
    assert.equal(category, 'Light sources');
  });

  it('prefers load-bearing kinds over decorative ones', () => {
    assert.equal(resolveCategory({ type: 'block^crafting material' }).category, 'Materials');
    assert.equal(resolveCategory({ type: 'weapon^crafting material' }).category, 'Weapons');
    assert.equal(resolveCategory({ type: 'vanity^set' }).category, 'Armor sets');
  });

  it('never lets a set tag reclassify a weapon', () => {
    // A min()-style promotion here once made weapon sets classify as Armor sets,
    // silently moving them out of the curated tier.
    assert.equal(resolveCategory({ type: 'weapon', tag: 'set' }).category, 'Weapons');
  });

  it('reports a categoryIdx that indexes CATEGORY_NAMES consistently', () => {
    const r = resolveCategory({ type: 'potion' });
    assert.equal(CATEGORY_NAMES[r.categoryIdx], r.category);
  });

  it('falls back to Uncategorised and reports the unmapped values', () => {
    const r = resolveCategory({ type: 'brand new type nothing knows' });
    assert.equal(r.category, 'Uncategorised');
    assert.equal(r.categoryIdx, CATEGORY_NAMES.length - 1);
    assert.deepEqual(r.unmapped, ['brand new type nothing knows']);
  });

  it('collects unmapped values even when another type resolves', () => {
    const r = resolveCategory({ type: 'weapon^totally unknown' });
    assert.equal(r.category, 'Weapons');
    assert.deepEqual(r.unmapped, ['totally unknown']);
  });
});

describe('resolveSourceMask', () => {
  it('sets one bit per applicable route — this is the point of tags', () => {
    // Torch: craftable and purchasable.
    const mask = resolveSourceMask({
      craftable: true,
      fished: false,
      dropped: false,
      purchasable: true,
    });
    assert.deepEqual(sourceTagsOf(mask), ['craft', 'shop']);
  });

  it('carries every route simultaneously', () => {
    const mask = resolveSourceMask({
      craftable: true,
      fished: true,
      dropped: true,
      purchasable: true,
    });
    assert.deepEqual(sourceTagsOf(mask), ['craft', 'fished', 'drop', 'shop']);
  });

  it('yields exactly the unknown bit when no route is found', () => {
    const mask = resolveSourceMask({
      craftable: false,
      fished: false,
      dropped: false,
      purchasable: false,
    });
    assert.equal(mask, UNKNOWN_MASK);
    assert.equal(isUnknownMask(mask), true);
    assert.deepEqual(sourceTagsOf(mask), ['unknown']);
  });

  it('never combines unknown with a real route', () => {
    for (const mask of [
      resolveSourceMask({ craftable: true, fished: true, dropped: true, purchasable: true }),
      resolveSourceMask({ craftable: false, fished: false, dropped: true, purchasable: false }),
      resolveSourceMask({ craftable: false, fished: false, dropped: false, purchasable: true }),
    ]) {
      assert.equal(mask & UNKNOWN_MASK, 0);
    }
  });

  it('keeps every mask inside the declared bit space', () => {
    const mask = resolveSourceMask({
      craftable: true,
      fished: true,
      dropped: true,
      purchasable: true,
    });
    assert.equal(mask & ~ALL_SOURCE_BITS, 0);
  });
});

describe('source bit positions', () => {
  it('are append-only and stable — a stored mask must not be reinterpreted', () => {
    assert.deepEqual(SOURCE_FLAGS, ['craft', 'fished', 'drop', 'shop', 'unknown']);
    assert.equal(SOURCE_BITS.craft, 1);
    assert.equal(SOURCE_BITS.fished, 2);
    assert.equal(SOURCE_BITS.drop, 4);
    assert.equal(SOURCE_BITS.shop, 8);
    assert.equal(SOURCE_BITS.unknown, 16);
    assert.equal(UNKNOWN_MASK, 16);
    assert.equal(ALL_SOURCE_BITS, 31);
  });
});

describe('pickCanonicalRow', () => {
  const legacy = { name: 'Shiny Black Slab', internalname: 'None', unobtainable: '1' };
  const live = { name: 'Wandering Jingasa', internalname: 'RoninHat', unobtainable: '' };

  it('prefers the row with a real internal name regardless of order', () => {
    assert.equal(pickCanonicalRow([legacy, live]), 1);
    assert.equal(pickCanonicalRow([live, legacy]), 0);
  });

  it('prefers the obtainable row when neither has an internal name', () => {
    const a = { name: 'A', internalname: 'None', unobtainable: '1' };
    const b = { name: 'B', internalname: 'None', unobtainable: '' };
    assert.equal(pickCanonicalRow([a, b]), 1);
    assert.equal(pickCanonicalRow([b, a]), 0);
  });

  it('is stable when rows are indistinguishable', () => {
    assert.equal(pickCanonicalRow([{ name: 'X' }, { name: 'X' }]), 0);
  });
});

describe('isTruthyCargo', () => {
  it('treats Cargo Boolean strings correctly', () => {
    assert.equal(isTruthyCargo('1'), true);
    assert.equal(isTruthyCargo('0'), false);
    assert.equal(isTruthyCargo(''), false);
    assert.equal(isTruthyCargo(undefined), false);
    assert.equal(isTruthyCargo('false'), false);
  });
});

describe('deriveRouteHint', () => {
  it('matches a route tag exactly', () => {
    assert.equal(deriveRouteHint(['hardmode', 'bag loot']), 'bag loot');
  });

  it('collapses a vendor: qualifier to the generic route', () => {
    assert.equal(deriveRouteHint(['vendor:merchant']), 'vendor');
    assert.equal(deriveRouteHint(['vendor:tavernkeep']), 'vendor');
  });

  it('respects ROUTE_TAGS priority rather than tag order', () => {
    assert.equal(deriveRouteHint(['vendor', 'quest rewards']), 'quest rewards');
  });

  it('returns null when nothing matches', () => {
    assert.equal(deriveRouteHint(['hardmode', 'wings']), null);
    assert.equal(deriveRouteHint([]), null);
  });
});

describe('resolveSubtype', () => {
  const w = (listcat) => resolveSubtype({ listcat, category: 'Weapons' });

  it('resolves a real kind, case- and whitespace-insensitively', () => {
    // listcat really ships both "Broadswords" and "broadswords".
    assert.equal(WEAPON_KINDS[w('Broadswords^Melee weapons^craftable items')].name, 'Broadswords');
    assert.equal(WEAPON_KINDS[w('broadswords^projectile melee^Melee weapons')].name, 'Broadswords');
    assert.equal(WEAPON_KINDS[w('  Bows ^ Ranged weapons ')].name, 'Bows');
  });

  it('ignores behaviour and flag values that are not kinds', () => {
    // This is why the rule is an allowlist. A Flamethrower carries `Scope`, and
    // treating any non-class value as a kind labelled it a scope (28 items).
    assert.equal(w('Scope^Ranged weapons^craftable items'), -1);
    assert.equal(w('projectile melee^Melee weapons'), -1);
    assert.equal(w('wall-piercing weapons^Magic weapons'), -1);
    assert.equal(w('loot items^bag loot items^Ranged weapons'), -1);
    assert.equal(w('craftable items'), -1);
  });

  it('rejects the malformed pipe value seen in live data', () => {
    assert.equal(w('projectile melee|+'), -1);
  });

  it('returns -1 when there is no kind at all', () => {
    assert.equal(w(''), -1);
    assert.equal(w('Ranged weapons^craftable items'), -1);
    assert.equal(w(undefined), -1);
  });

  it('only ever applies to Weapons', () => {
    // A stray listcat value must not attach a weapon kind to another category.
    assert.equal(resolveSubtype({ listcat: 'Guns', category: 'Tools' }), -1);
    assert.equal(resolveSubtype({ listcat: 'Guns', category: 'Accessories' }), -1);
  });

  it('every kind index is reachable and declared under Weapons', () => {
    for (const kind of WEAPON_KINDS) assert.equal(kind.parent, 'Weapons');
  });
});

describe('classifyListcat', () => {
  it('separates resolved kinds from ignored values', () => {
    const r = classifyListcat('Broadswords^projectile melee^Melee weapons^craftable items');
    assert.deepEqual(r.kinds, ['Broadswords']);
    assert.ok(r.ignored.includes('projectile melee'));
    assert.ok(r.ignored.includes('craftable items'));
  });

  it('reports nothing for an empty value', () => {
    assert.deepEqual(classifyListcat(''), { kinds: [], ignored: [] });
  });
});

describe('parseDropRates', () => {
  // The wiki's real markup, copied verbatim from the Drops table. These fixtures
  // are the point of the test: the parser got this wrong twice, once by using a
  // non-greedy match and once by stripping the tags that carry the mode classes.
  const ROD_OF_DISCORD =
    '<span class="mode-content"><span class="m-normal m-journey">0.2%</span>' +
    '<span class="m-expert-master">[[Expert Mode|<span class="mode-exclusive expert" >0.25%</span>]]</span></span>';

  const SLIME_STAFF =
    '<span class="mode-content"><span class="m-normal">0.01%</span>' +
    '<span class="m-expert-master">[[Expert Mode|<abbr class="mode-exclusive expert" title="Expert Mode ">0.014%</abbr>]]</span></span>';

  const UNIFORM =
    '<span class="chance" data-sort-value="50">1/2 (50%)</span>';

  it('reads a different rate per difficulty out of nested mode spans', () => {
    // Normal 0.2% but Expert/Master 0.25%. Reporting 0.2% for all three was the
    // original bug, caused by stripping tags before reading the mode classes.
    assert.deepEqual(parseDropRates(ROD_OF_DISCORD), {
      normal: 0.2,
      expert: 0.25,
      master: 0.25,
    });
  });

  it('handles <abbr> as well as <span>, and 3-decimal rates', () => {
    assert.deepEqual(parseDropRates(SLIME_STAFF), {
      normal: 0.01,
      expert: 0.014,
      master: 0.014,
    });
  });

  it('applies a single unsegmented rate to every difficulty', () => {
    assert.deepEqual(parseDropRates(UNIFORM), {
      normal: 50,
      expert: 50,
      master: 50,
    });
  });

  it('never mistakes a drop quantity for a rate', () => {
    // data-sort-value in this table belongs to the quantity. It previously
    // hijacked the parse, yielding a 1.4% "rate" for a 0.01% drop.
    const withQuantity =
      '<span class="mode-content"><span class="m-normal">0.01%</span>' +
      '<span class="m-expert-master">1.4</span></span>';
    const rates = parseDropRates(withQuantity);
    assert.equal(rates.normal, 0.01);
    assert.notEqual(rates.expert, 1.4);
  });

  it('returns null for empty or non-numeric input', () => {
    assert.equal(parseDropRates(''), null);
    assert.equal(parseDropRates(undefined), null);
    assert.equal(parseDropRates('<span>no numbers here</span>'), null);
  });
});

describe('difficulty masks', () => {
  it('decodes the normal/expert/master flags', () => {
    assert.equal(difficultyMaskFromFlags('1', '0', '0'), DIFFICULTY_BITS.normal);
    assert.equal(difficultyMaskFromFlags('0', '1', '1'), DIFFICULTY_BITS.expert | DIFFICULTY_BITS.master);
    assert.equal(difficultyMaskFromFlags('1', '1', '1'), DIFFICULTY_MASK_ALL);
  });

  it('treats empty Cargo booleans as false', () => {
    assert.equal(difficultyMaskFromFlags('', '', ''), 0);
  });

  it('keeps bit positions stable, since stored masks depend on them', () => {
    assert.deepEqual(difficultyNames(DIFFICULTY_MASK_ALL), ['normal', 'expert', 'master']);
    assert.equal(DIFFICULTY_BITS.normal, 1);
    assert.equal(DIFFICULTY_BITS.expert, 2);
    assert.equal(DIFFICULTY_BITS.master, 4);
  });

  it('tags an item only when NO source works on Normal', () => {
    // Obtainable on Normal at all -> not difficulty-restricted.
    assert.equal(deriveDifficultyTag([DIFFICULTY_MASK_ALL]), null);
    assert.equal(deriveDifficultyTag([DIFFICULTY_BITS.normal, DIFFICULTY_BITS.master]), null);
    // Expert + Master only (a treasure bag).
    assert.equal(deriveDifficultyTag([DIFFICULTY_BITS.expert | DIFFICULTY_BITS.master]), 'expert-master');
    // Master only.
    assert.equal(deriveDifficultyTag([DIFFICULTY_BITS.master]), 'master');
    // Expert only.
    assert.equal(deriveDifficultyTag([DIFFICULTY_BITS.expert]), 'expert');
  });

  it('unions across drop sources before deciding', () => {
    // Blade Staff: Queen Slime drops it on Normal, so despite a treasure-bag-only
    // source it is NOT expert-restricted.
    assert.equal(deriveDifficultyTag([DIFFICULTY_BITS.normal, DIFFICULTY_BITS.expert | DIFFICULTY_BITS.master]), null);
  });

  it('returns null when there are no drops to reason about', () => {
    assert.equal(deriveDifficultyTag([]), null);
    assert.equal(deriveDifficultyTag([0]), null);
  });
});

describe('schema version', () => {
  it('is 3, the bitmask revision', () => {
    assert.equal(SCHEMA_VERSION, 3);
  });
});
