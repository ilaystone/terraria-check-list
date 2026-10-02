/**
 * Per-difficulty data, derived from the wiki's `Drops` table.
 *
 * There is no difficulty column on `Items` — the only related field is `hardmode`,
 * which is a progression gate, not a difficulty. Difficulty therefore comes from
 * two places on each drop row:
 *
 *  1. The `normal` / `expert` / `master` booleans, which say *which difficulties
 *     the drop exists in at all*. A treasure-bag-only item is `011`: Expert and
 *     Master only.
 *  2. The `rate` field, which embeds a *different rate per difficulty* as HTML:
 *
 *       <span class="mode-content">
 *         <span class="m-normal m-journey">0.01%</span>
 *         <span class="m-expert-master">[[Expert Mode|1%]]</span>
 *       </span>
 *
 *     Slime Staff is 0.01% on Normal and 1% on Expert/Master. Collapsing that to
 *     a single number would lose the reason the item is hard to get.
 */

/** Bit per difficulty. Order defines bit positions and must stay append-only. */
export const DIFFICULTIES = ['normal', 'expert', 'master'];

export const DIFFICULTY_BITS = Object.fromEntries(
  DIFFICULTIES.map((d, i) => [d, 1 << i]),
);

export const DIFFICULTY_MASK_ALL =
  DIFFICULTIES.reduce((m, d) => m | DIFFICULTY_BITS[d], 0);

/** `'100'` -> normal only, `'011'` -> expert+master, `'111'` -> all. */
export function difficultyMaskFromFlags(normal, expert, master) {
  let mask = 0;
  if (isCargoTrue(normal)) mask |= DIFFICULTY_BITS.normal;
  if (isCargoTrue(expert)) mask |= DIFFICULTY_BITS.expert;
  if (isCargoTrue(master)) mask |= DIFFICULTY_BITS.master;
  return mask;
}

function isCargoTrue(v) {
  const s = String(v ?? '').trim();
  return s !== '' && s !== '0';
}

/** Difficulty names set in a mask. */
export function difficultyNames(mask) {
  return DIFFICULTIES.filter((d) => (mask & DIFFICULTY_BITS[d]) !== 0);
}

/** True when the mask covers every difficulty. */
export function isAllDifficulties(mask) {
  return mask === DIFFICULTY_MASK_ALL;
}

/** Seasoning for a display colour: 'all' | 'normal-only' | 'expert-plus' | 'mixed'. */
export function difficultyClass(mask) {
  if (isAllDifficulties(mask)) return 'all';
  if (mask === DIFFICULTY_BITS.normal) return 'normal-only';
  if (mask === 0) return 'none';
  if ((mask & DIFFICULTY_BITS.normal) === 0) return 'expert-plus';
  return 'mixed';
}

/**
 * Marker inserted where a mode block begins, so mode boundaries survive tag
 * stripping. Chosen to be something no item name or rate text can contain.
 */
const MODE_MARK = '\u0001MODE\u0001';

/**
 * Parse the wiki's mode-segmented drop rate HTML into a rate per difficulty.
 *
 * The markup nests spans, and the mode lives in a CLASS ATTRIBUTE:
 *
 *   <span class="mode-content">
 *     <span class="m-normal m-journey">0.2%</span>
 *     <span class="m-expert-master">[[Expert Mode|<span
 *       class="mode-exclusive expert">0.25%</span>]]</span>
 *   </span>
 *
 * Two mistakes are easy here, and this function made both at first:
 *
 *  1. Using a non-greedy `class="m-(...)"[^>]*>(.*?)</span>` stops at the first
 *     closing tag, truncating nested content.
 *  2. **Stripping tags before reading the classes.** The mode names only exist on
 *     the tags, so removing them leaves `" 0.2%   0.25%   "` — no modes at all.
 *     Every rate then silently collapsed to the first number found, reporting a
 *     0.2% Expert rate where the wiki says 0.25%.
 *
 * So mode boundaries are captured while the HTML is intact, then tag stripping
 * happens with the markers preserved.
 *
 * @param {string} html the `rate` field
 * @returns {{ normal: number|null, expert: number|null, master: number|null }|null}
 */
export function parseDropRates(html) {
  if (!html) return null;

  // Keep only the mode-content region; anything outside it is presentation.
  let markup = /class="mode-content">([\s\S]*)/.exec(String(html))?.[1] ?? String(html);

  // Drop wiki links but keep their visible label: [[Expert Mode|0.25%]] -> 0.25%
  markup = markup
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1');

  // Mark each mode boundary while the classes are still present. Both spellings
  // occur: `m-normal m-journey` and `mode-exclusive expert`.
  markup = markup.replace(
    /<(?:span|abbr)\b[^>]*\bclass="([^"]*)"[^>]*>/gi,
    (whole, classes) => {
      const modes = [];
      // `m-normal`, `m-expert-master`, `m-journey` (journey is not a difficulty).
      const direct = /(?:^|\s)m-([a-z-]+)(?=\s|$)/.exec(classes);
      if (direct) modes.push(direct[1]);
      const exclusive = /(?:^|\s)mode-exclusive\s+([a-z-]+)/.exec(classes);
      if (exclusive) modes.push(exclusive[1]);
      if (modes.length === 0) return whole;
      return MODE_MARK + modes.join('-') + MODE_MARK;
    },
  );

  // Now the tags can go; the markers stay because they are not tag syntax.
  const text = markup.replace(/<[^>]*>/g, ' ');

  const out = { normal: null, expert: null, master: null };
  let found = false;
  const parts = text.split(MODE_MARK);

  // parts = [before, modes, value, modes, value, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const modes = parts[i].split('-').filter(Boolean);
    const value = extractPercent(parts[i + 1]);
    if (value === null) continue;
    for (const mode of modes) {
      if (mode in out && out[mode] === null) {
        out[mode] = value;
        found = true;
      }
    }
  }

  if (!found) {
    // No usable mode segmentation: one rate applying to every difficulty.
    const value = extractPercent(text);
    if (value === null) return null;
    out.normal = value;
    out.expert = value;
    out.master = value;
  } else {
    // An unstated mode inherits the nearest stated one. A mode that genuinely has
    // no rate keeps `null`, which is what distinguishes "cannot drop here" from
    // "rate unknown".
    if (out.expert === null) out.expert = out.normal;
    if (out.master === null) out.master = out.expert;
  }

  return out;
}

/**
 * Pull the first percentage out of a plain-text fragment.
 *
 * `data-sort-value` is deliberately NOT consulted: in this table it belongs to
 * the drop *quantity*, not the rate, which is exactly what corrupted the parse.
 */
function extractPercent(fragment) {
  const match = /([\d.]+)\s*%/.exec(String(fragment));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Human-readable rate, or null when unknown. Keeps small values legible. */
export function formatRate(percent) {
  if (percent === null || percent === undefined) return null;
  if (percent === 0) return '0%';
  if (percent < 0.01) return `${percent}%`;
  if (percent < 1) return `${percent}%`;
  return `${percent}%`;
}

/**
 * The difficulty tag to surface for an item, given every drop it has.
 *
 * Returns the *narrowest* set that still yields the item — an item that drops in
 * every difficulty is not interesting, but one that only exists in Expert is.
 * Items with no drops get `null` (difficulty comes from elsewhere, or nowhere).
 *
 * @param {number[]} masks per-drop difficulty masks
 * @returns {'expert'|'master'|'expert-master'|null}
 */
export function deriveDifficultyTag(masks) {
  const usable = masks.filter((m) => m !== 0);
  if (usable.length === 0) return null;

  // Union: if ANY drop source works on Normal, the item is obtainable on Normal.
  const union = usable.reduce((a, b) => a | b, 0);
  if (union & DIFFICULTY_BITS.normal) return null;

  const hasExpert = (union & DIFFICULTY_BITS.expert) !== 0;
  const hasMaster = (union & DIFFICULTY_BITS.master) !== 0;
  if (hasExpert && hasMaster) return 'expert-master';
  if (hasMaster) return 'master';
  if (hasExpert) return 'expert';
  return null;
}
