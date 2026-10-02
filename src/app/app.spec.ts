import { formatCoins, hasSource, sourceNames, spriteUrl } from './core/models';
import {
  parseStoredProgress,
  reconcile,
  serialise,
  toggleIn,
} from './core/progress-core';

/**
 * Unit tests for the logic that fails silently.
 *
 * Deliberately no component rendering tests and no TestBed: the components are
 * presentational signal bindings, and `ProgressStore` is a thin shell. Every
 * decision worth asserting was extracted into pure functions so it can be tested
 * directly — a wrong reconcile drops a player's progress, which no type checker
 * or rendering test would catch.
 */

describe('spriteUrl', () => {
  const base = 'https://terraria.wiki.gg/images/';

  it('replaces spaces with underscores, which is how the wiki stores item files', () => {
    // The wiki's Imageinfo table holds "Terra Blade.png" (with a space) and
    // serves it at the underscored URL. Getting this wrong 404s every sprite.
    expect(spriteUrl('Terra Blade')).toBe(`${base}Terra_Blade.png`);
    expect(spriteUrl('Dirt Block')).toBe(`${base}Dirt_Block.png`);
  });

  it('escapes sub-delimiters that are legal in a URL but not in a path segment', () => {
    // The apostrophe must be percent-encoded rather than emitted raw.
    const url = spriteUrl("Betsy's Wrath");
    expect(url).toBe(`${base}Betsy%27s_Wrath.png`);
    expect(url).not.toContain("'");
    expect(decodeURIComponent(url.slice(base.length))).toBe("Betsy's_Wrath.png");
  });

  it('escapes the exclamation mark, which item names use', () => {
    expect(spriteUrl('Fish Finder!')).toBe(`${base}Fish_Finder%21.png`);
  });

  it('leaves names that need no escaping untouched', () => {
    expect(spriteUrl('Zenith')).toBe(`${base}Zenith.png`);
    expect(spriteUrl('S.D.M.G.')).toBe(`${base}S.D.M.G..png`);
  });

  it('handles names with multiple spaces and leading/trailing ones', () => {
    expect(spriteUrl('Silly Balloon Purple')).toBe(`${base}Silly_Balloon_Purple.png`);
  });
});

describe('source bitmask helpers', () => {
  const flags = ['craft', 'fished', 'drop', 'shop', 'unknown'];

  it('reports every route set in the mask', () => {
    // Torch: craftable (1) + droppable (4) + purchasable (8) = 13.
    expect(sourceNames(13, flags)).toEqual(['craft', 'drop', 'shop']);
  });

  it('treats `unknown` as standalone', () => {
    expect(sourceNames(16, flags)).toEqual(['unknown']);
    expect(hasSource(16, 0)).toBe(false);
  });

  it('reports no routes for an empty mask', () => {
    expect(sourceNames(0, flags)).toEqual([]);
  });
});

describe('formatCoins', () => {
  it('renders copper as game-style coin text', () => {
    expect(formatCoins(30_000)).toBe('3 Gold');
    expect(formatCoins(35_000)).toBe('3 Gold 50 Silver');
    expect(formatCoins(50)).toBe('50');
  });

  it('renders an em dash when there is no price', () => {
    expect(formatCoins(undefined)).toBe('—');
    expect(formatCoins(0)).toBe('—');
  });
});

describe('toggleIn', () => {
  it('adds then removes the same id', () => {
    const once = toggleIn(new Set<number>(), 757);
    expect([...once]).toEqual([757]);
    const twice = toggleIn(once, 757);
    expect(twice.size).toBe(0);
  });

  it('does not mutate the input set', () => {
    const original = new Set([1]);
    toggleIn(original, 2);
    expect([...original]).toEqual([1]);
  });
});

describe('parseStoredProgress', () => {
  it('accepts a well-formed payload', () => {
    const result = parseStoredProgress(JSON.stringify({ v: 3, ids: [1, 2, 3] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.v).toBe(3);
      expect(result.data.ids).toEqual([1, 2, 3]);
    }
  });

  it('treats absent storage as "nothing stored", not an error', () => {
    expect(parseStoredProgress(null)).toEqual({ ok: false, issue: null });
    expect(parseStoredProgress('')).toEqual({ ok: false, issue: null });
  });

  it('reports corrupted JSON rather than throwing', () => {
    expect(parseStoredProgress('not json{{{')).toEqual({ ok: false, issue: 'corrupted' });
  });

  it('reports an unexpected shape', () => {
    expect(parseStoredProgress('{"nope":true}')).toEqual({ ok: false, issue: 'unreadable' });
    expect(parseStoredProgress('[]')).toEqual({ ok: false, issue: 'unreadable' });
    expect(parseStoredProgress('"a string"')).toEqual({ ok: false, issue: 'unreadable' });
  });

  it('discards junk inside the ids array instead of trusting it', () => {
    const result = parseStoredProgress(JSON.stringify({ v: 3, ids: [1, 'x', null, 2.5, -3, 4] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ids).toEqual([1, 4]);
  });

  it('defaults a missing version to 0 so it reads as a schema change', () => {
    const result = parseStoredProgress(JSON.stringify({ ids: [1] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.v).toBe(0);
  });
});

describe('reconcile', () => {
  const valid = new Set([1, 2, 3]);

  it('returns nothing when nothing was stored', () => {
    expect(reconcile(null, 3, valid)).toEqual({
      ids: [],
      dropped: 0,
      schemaChanged: false,
      issue: null,
    });
  });

  it('restores ids present in the snapshot', () => {
    const outcome = reconcile({ v: 3, ids: [1, 3] }, 3, valid);
    expect(outcome.ids).toEqual([1, 3]);
    expect(outcome.dropped).toBe(0);
    expect(outcome.schemaChanged).toBe(false);
  });

  it('drops ids that no longer exist, and counts them', () => {
    // This is the case that matters: a regenerated snapshot renumbers or removes
    // items, and a kept stale id would inflate the player's count forever.
    const outcome = reconcile({ v: 3, ids: [1, 999, 1000] }, 3, valid);
    expect(outcome.ids).toEqual([1]);
    expect(outcome.dropped).toBe(2);
  });

  it('flags a schema version change while preserving what it can', () => {
    const outcome = reconcile({ v: 2, ids: [1, 2] }, 3, valid);
    expect(outcome.schemaChanged).toBe(true);
    expect(outcome.ids).toEqual([1, 2]);
  });

  it('treats a version-less payload as an older schema', () => {
    const outcome = reconcile({ v: 0, ids: [1] }, 3, valid);
    expect(outcome.schemaChanged).toBe(true);
  });
});

describe('serialise', () => {
  it('sorts ids so the stored payload is stable and diffable', () => {
    const json = serialise(new Set([9, 1, 5]), 3);
    const parsed = JSON.parse(json) as { v: number; ids: number[] };
    expect(parsed.ids).toEqual([1, 5, 9]);
    expect(parsed.v).toBe(3);
  });

  it('round-trips through parseStoredProgress', () => {
    const json = serialise(new Set([7, 3]), 3);
    const parsed = parseStoredProgress(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.ids).toEqual([3, 7]);
  });
});
