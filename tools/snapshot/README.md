# Snapshot generator

Generates the Terraria item checklist data from the [Terraria Wiki](https://terraria.wiki.gg)
and commits it to `public/data/`. The web app is then a **pure static front end** — it never
talks to the wiki.

## Why build-time and not runtime

The obvious design — have the browser fetch the item list from the wiki — does not work, and
not for a reason that can be worked around client-side:

> `{"error":{"code":"ratelimited","info":"You've exceeded your rate limit. Please make sure
> you are setting a custom user agent with the username of your wiki account."}}`

Browsers cannot set `User-Agent` (it is a forbidden header), so every runtime fetch is
rate-limited from the first request, with no fix available in application code. Fetching at
build time also means:

- the snapshot is reproducible and reviewable — data changes show up as a git diff
- contributors never need wiki access or network to build the app
- no third-party runtime dependency, so the site cannot break when the wiki is slow
- a truncated or schema-drifted fetch fails CI instead of silently shipping a half-empty list

## Usage

```bash
npm run gather            # regenerate from cache; fetch only if no cache exists
npm run gather:refresh    # re-fetch every table from the wiki (slow, polite)
npm run gather:offline    # never touch the network
npm run gather:check      # report schema drift against the cache, change nothing
npm run verify            # re-run the integrity gate on the emitted files
```

Set a real contact before fetching, as the wiki asks:

```bash
SNAPSHOT_CONTACT="MyWikiName" npm run gather:refresh
```

## Pipeline

```
fetch (cached)  ->  normalize  ->  emit  ->  validate
tools/snapshot/     .cache/snapshot/  public/data/
```

| File | Role |
|---|---|
| `gather.mjs` | CLI orchestration and reporting |
| `wiki-client.mjs` | API client: User-Agent, `maxlag`, throttling, backoff, pagination |
| `fetch.mjs` | Stage 1 — pulls `Items`, `Recipes`, `Drops`; disk cache with content hashes |
| `normalize.mjs` | Stage 2 — pure transform, no I/O |
| `schema.mjs` | The shared contract: categories, source flags, precedence rules |
| `emit.mjs` | Stage 3 — atomic writes into `public/data/` |
| `validate.mjs` | Integrity gate; non-zero exit fails the build |
| `curation.json` | Hand-edited inclusion rules, never overwritten by the generator |

Normalisation is a pure function of the cached rows, so iterating on category rules costs
zero wiki requests (`--rebuild`).

## Wiki etiquette

Required, not optional:

- a descriptive `User-Agent` with contact details (`SNAPSHOT_CONTACT`)
- `maxlag=5` on every request, so the pipeline yields to editors during replication lag
- one request at a time, 3.5 s apart (verified safe)
- exponential backoff on 429/5xx, never parallel bursts
- `limit` capped at 500 — Cargo silently returns 500 for larger values

## The three rules that matter

### 1. `type` is not a partition

2442 of 6355 rows carry multiple `type` values. `Torch` is
`furniture^light source^crafting material`; `Wood` is `block^crafting material`. Filtering by
"has type X" would put one item in three lists and make every count wrong.

`resolveCategory()` therefore intersects type/tag against a **priority-ordered** list and
returns exactly one category. Priority puts kinds a player thinks of as load-bearing
(weapons, armor, accessories) above incidental ones, so a torch is a light source rather
than furniture.

### 2. Nine item ids are shared by two different items

Legacy mobile/3DS content collides with current content:

| id | legacy | current |
|---|---|---|
| 5036 | Ocram Trophy | Otherworldly Music Box (Lunar Boss) |
| 5048 | Shiny Black Slab | Wandering Jingasa |
| 5076 | Red Envelope | Royal Scepter |
| 5078 | Mythical Lion Mask | Prince Uniform |
| 5079 | Firecracker (mobile) | Prince Pants |

The legacy row always carries `internalname = "None"`, so `pickCanonicalRow()` prefers the row
with a real internal name, then the row not flagged `unobtainable`. Progress state keys on
`itemid`, so an unresolved collision would corrupt user progress.

### 3. Obtainability is a set, not a single value

An item is very often obtainable more than one way, so each item carries a **bitmask** of every
route that applies and the app renders one badge per set bit:

| item | tags |
|---|---|
| Torch | `craft` + `drop` + `shop` |
| Golden Crate | `craft` + `fished` |
| Terra Blade | `craft` |
| Minishark | `shop` |
| Rod of Discord | `drop` |

This replaced an earlier single-value flag with a precedence order, which discarded real
routes: it reported Torch as `craft` only, hiding that it is also purchasable. **321 items
carry more than one route**, so that information loss was not marginal.

There is deliberately **no "primary route"**. The wiki never states one, and ranking craft
above drop above purchase would fabricate information. If the UI wants to order or prioritise
badges, that is a UI decision, not a data one.

`unknown` (bit 4, mask 16) is the only tag meaning "no route found", and the validator fails
the build if it is ever combined with another tag. Bits are append-only: positions must never
move once a snapshot has shipped, because a stored mask would be silently reinterpreted.

`unknown` is **not** the same as unobtainable. Only 49 items carry the wiki's `unobtainable`
flag; fishing, world-gen chest loot and quest rewards are not covered by these three tables.

### 4. Weapon kinds come from `listcat`, via an allowlist

`type` alone gives "Weapons" (487 items). Cargo's `listcat` field carries a weapon's *kind*
(Broadswords, Guns, Yoyos), which lets the UI render a two-level tree instead of a flat list.

It is not usable as-is. `listcat` mixes kinds with behaviours, properties and acquisition
flags, ships 27 case/whitespace variants of the same value, and contains a malformed
`projectile melee|+` entry. So `resolveSubtype()` matches against an explicit **allowlist** of
16 kinds rather than accepting "any value that isn't a class":

| rejected value | why | cost of accepting it |
|---|---|---|
| `scope` | a wiki property, not a kind | 28 items (incl. Flamethrower) become "scope" |
| `projectile melee` | combat behaviour | 60 items miss their real kind |
| `wall-piercing weapons` | property | 16 items miss their real kind |
| `loot items`, `craftable items`, `drop items` | acquisition flags — duplicate `tag` | invents categories from routes |
| `buffs`, `debuffs`, `potion ingredients` | unrelated to weapon kind | misclassification |

Measured result: **351 of 487 weapons (72.1%) resolve to one of 16 kinds**, and no item ever
carries two kinds, so "first allowlist match wins" is unambiguous. The remaining 136 are mostly
throwables (Shuriken, Grenade, Throwing Knife) whose `listcat` only ever says the generic
`Ranged weapons`; they keep their **parent** category rather than being dumped into an
"Other weapons" bucket.

The layer is deliberately additive and weapon-only: `subIdx` is omitted from an item when no
kind resolves, so 5,789 of 6,140 rows are unchanged and nothing is ever mislabelled. `Zenith`
is broadsword-shaped but carries no kind in `listcat`, so it reports plain `Weapons` — the
fallback behaving as designed, not a bug.



## Data contract

Committed files in `public/data/`:

```jsonc
// catalog.json — small, on the critical path
{
  "meta": {
    "schemaVersion": 3,
    "generatedAt": "…",
    "wikiRevision": { "page": "Terraria Wiki", "revid": 1032533, "timestamp": "…" },
    "sourceTables":  { "items": 6355, "recipes": 4266, "drops": 3253, "npcs": 770 },
    "sourceHashes":  { "items": "…", "recipes": "…", "drops": "…", "npcs": "…" }
  },
  "categories":     ["Weapons", "Ammunition", "…"],                 // index = categoryIdx
  "sourceFlags":    ["craft", "fished", "drop", "shop", "unknown"], // bit (1 << i)
  "unknownBit":     16,
  "subtypes":       [{ "name": "Broadswords", "parent": "Weapons" }, "…"],
  "difficulties":   ["normal", "expert", "master"],
  "difficultyBits": { "normal": 1, "expert": 2, "master": 4 }
}

// items.index.json — everything the list view needs per row
[{ "id": 757, "name": "Terra Blade", "nameLower": "terra blade",
   "categoryIdx": 0, "src": 1, "curated": true, "subIdx": 0 }]

// items.detail.json — market/research stats, one page at a time
{ "757": { "r": "1", "s": "9999", "sl": 200000, "h": 1 } }

// items.sources.json — how to obtain it; only for items that have any
{ "757": { "craft": [{ "st": "Mythril Anvil",
                       "ings": [{ "n": "Broken Hero Sword", "q": 1 }, "…"] }] },
  "8":   { "craft": [{ "st": "By Hand", "n": 3, "ings": ["…"] }],
           "drop":  [{ "s": "Blue Slime", "q": "5–10" }],
           "shop":  [{ "npc": "merchant", "price": 50 }] } }

// refs.json — enemy lookup for drop sources, keyed by raw name
{ "npcs": { "Chaos Elemental": { "name": "Chaos Elemental", "id": 215,
                                 "kind": "…", "env": "Underground Hallow" } } }
```

Source keys: `st` station, `ings` ingredients (`n` name, `q` quantity), `n` output count,
`s` source name for a drop, `q` quantity as the wiki states it, `d` difficulty bitmask,
`r` rate per difficulty, `npc`/`price` for a vendor.

### Why `items.sources.json` is separate

It is the largest file (~640 KB raw) and the list view never renders a recipe. Splitting it
keeps browsing fast while only an item's own page pays for its acquisition detail.

### Difficulty is derived, not stored

There is **no difficulty column** in the wiki's `Items` table — only `hardmode`, which is a
progression gate rather than a difficulty. So a difficulty tag is derived from drop data in
two ways:

1. The `normal`/`expert`/`master` booleans on each drop row, which state *which difficulties
   the drop exists in at all*.
2. The `rate` field, which embeds a **different rate per difficulty** as HTML — Slime Staff is
   0.01% on Normal and 1% on Expert/Master.

`deriveDifficultyTag()` unions every drop source and returns a tag only when **no** source works
on Normal. Blade Staff therefore gets no tag: Queen Slime drops it on Normal, even though a
treasure bag also drops it.

Parsing that HTML is the most fragile part of the generator, and it was wrong twice:

- A non-greedy `class="m-(...)"(.*?)</span>` stopped at the first closing tag, and a
  neighbouring `data-sort-value` — which in this table is the drop **quantity**, not the rate —
  was picked up as the rate.
- Stripping tags *before* reading the classes removed the mode information entirely, so every
  rate silently collapsed to the first number found (0.2% reported where the wiki says 0.25%).

Both are now covered by tests using verbatim wiki markup.

Detail keys: `r` research, `s` stack, `b` buy (copper), `sl` sell (copper), `p` placeable,
`c` consumable, `h` hardmode, `u` unobtainable, `hint` advisory source hint, `t` tags.
Absent key means falsy.

`buy`/`sell` are copper, parsed from `data-sort-value` in the wiki's rendered coin HTML —
never parse the visible text. Items priced in a non-coin currency (Defender Medals) are
rejected rather than recorded as a coin price.

### What the tag counts actually mean

A tag counts an item in **every** bucket it sets, so the totals deliberately sum above the
item count. On the curated tier:

| tag | items |
|---|---:|
| `craft` | 1,797 |
| `drop` | 825 |
| `shop` | 464 |
| `fished` | 47 |
| `unknown` | 432 |

Across all 6,140 items: `craft=3375 fished=77 drop=1153 shop=752 unknown=1119`, with 321 items
carrying more than one route (238 of them curated). `craft=3375` therefore does **not** mean
3,375 items are craft-only — it means 3,375 are craftable, and some of those are also droppable
or purchasable. Read `bySourceCombo` in the diagnostics for the real breakdown.

Of the 432 curated unknowns, **284 carry a wiki tag naming a route** the three Cargo tables do
not cover (`bag loot`, `treasure bag loot`, `quest rewards`, `plunder`, `vendor:*`). Those are
emitted as `hint`: advisory, and only ever present when the mask is `unknown`. They are kept
out of the mask deliberately — the mask records routes derived from Recipes/Drops/buy, while a
tag is an unverified claim from the item page, and mixing the two confidence levels in one
field would make the mask mean nothing precise. The remaining ~148 curated unknowns (world-gen
chests, naturally growing plants, music boxes) are genuinely unresolvable from these tables and
are shown as unknown rather than guessed.

`schemaVersion` lives in `catalog.json`. The snapshot under `public/data/` is committed, which
is what makes data changes reviewable as a diff. `.cache/` is gitignored — it is only an
optimisation, and `--offline` fails loudly rather than trusting a stale cache.

### Progress state belongs to the app, not the snapshot

Store progress as a set of **item ids**. Never names (they drift between snapshots), never
array indices (they shift). On `schemaVersion` change, migrate rather than discard.

## Curation

`curation.json` is hand-edited and merged after normalisation, so re-running the generator
never destroys edits. It selects the default tier:

- `includeCategories` — shipped as `curated: true` (the default 3,321-item view)
- `extraCategories` — shipped, but `curated: false`; reveal behind a toggle
- `extraItems` / `excludeItems` — explicit id overrides

The extended categories are emitted in the same file rather than fetched separately, so
toggling is a client-side filter with no extra request.

## Diagnostics

Written to `.cache/snapshot/diagnostics.json`, never shipped: per-category and per-source
counts, unmapped wiki type values, recipe/drop names that matched no item, id-collision
detail, and id-less rows. `unmappedTypes` growing means the wiki added a type value that
`schema.mjs` does not know about yet.
