/**
 * MediaWiki / Cargo API client for the Terraria Wiki (wiki.gg).
 *
 * The etiquette implemented here is not optional. The wiki's rate limiter
 * returned HTTP 429 with this exact instruction during reconnaissance:
 *
 *   "You've exceeded your rate limit. Please make sure you are setting a custom
 *    user agent with the username of your wiki account."
 *
 * So we identify ourselves, space requests out, honour maxlag (yielding to
 * editors during replication lag), and back off exponentially instead of
 * hammering. Politeness is what keeps `npm run gather` working.
 */

export const API_ENDPOINT = 'https://terraria.wiki.gg/api.php';

/** Minimum gap between requests. Verified safe during reconnaissance. */
export const MIN_REQUEST_GAP_MS = 3500;

const MAX_ATTEMPTS = 6;
const MAXLAG = 5;

/**
 * The wiki asks for a User-Agent naming a contact. Set SNAPSHOT_CONTACT to your
 * wiki username or e-mail. The placeholder is deliberately recognisable so a
 * fork does not silently impersonate this repo.
 */
export function userAgent() {
  const contact = process.env.SNAPSHOT_CONTACT ?? 'https://github.com/OWNER/terraria-checklist';
  return `TerrariaChecklist-Snapshot/0.1 (build-time data snapshot; ${contact})`;
}

/**
 * @param {boolean} [quiet]
 */
export function createLogger(quiet = false) {
  const stamp = () => new Date().toISOString().slice(11, 19);
  return {
    info: (m) => !quiet && console.log(`[${stamp()}] ${m}`),
    warn: (m) => console.warn(`[${stamp()}] WARN ${m}`),
    step: (m) => !quiet && console.log(`[${stamp()}] -> ${m}`),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WikiApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} body
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'WikiApiError';
    this.status = status;
    this.body = body;
  }
}

/** Serialises every request through one queue so we can never burst. */
let nextSlot = 0;

async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_REQUEST_GAP_MS;
  if (at > now) await sleep(at - now);
}

export class WikiClient {
  /**
   * @param {{ logger: ReturnType<typeof createLogger>, noThrottle?: boolean }} opts
   */
  constructor(opts) {
    this.logger = opts.logger;
    this.noThrottle = opts.noThrottle ?? false;
  }

  /**
   * Perform one API call and return parsed JSON.
   * Retries on 429, 5xx, and MediaWiki maxlag errors with exponential backoff.
   *
   * @param {Record<string, string|number>} params
   */
  async call(params) {
    const search = new URLSearchParams({
      format: 'json',
      formatversion: '2',
      maxlag: String(MAXLAG),
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    const url = `${API_ENDPOINT}?${search}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!this.noThrottle) await waitForSlot();

      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        });
      } catch (err) {
        // Transport failure: retry, so a transient DNS/TLS blip does not abort a
        // paginated pipeline half way through.
        if (attempt === MAX_ATTEMPTS - 1) throw err;
        const wait = 2000 * 2 ** attempt;
        this.logger.warn(`network error (${err.message}); retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const body = await res.text();

      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new WikiApiError(`giving up after ${MAX_ATTEMPTS} attempts`, res.status, body);
        }
        const wait = 5000 * (attempt + 1);
        this.logger.warn(`HTTP ${res.status}; backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new WikiApiError(`HTTP ${res.status}`, res.status, body);

      const json = JSON.parse(body);

      // MediaWiki signals replication lag as a 200 carrying an error object.
      if (json?.error?.code === 'maxlag') {
        if (attempt === MAX_ATTEMPTS - 1) throw new WikiApiError('persistent maxlag', res.status, body);
        const wait = 5000 * (attempt + 1);
        this.logger.warn(`maxlag exceeded; backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (json?.error) throw new WikiApiError(`${json.error.code}: ${json.error.info}`, res.status, body);

      return json;
    }

    throw new WikiApiError('unreachable', 0, '');
  }

  /**
   * Cargo query with automatic offset pagination.
   *
   * Cargo reports no total, so we page until a short batch arrives. `limit` is
   * capped at 500 server-side. Never rely on Cargo's COUNT() for the total: it
   * is inconsistent for `isList` fields (a single value returns 6355 while
   * distinct item ids are 6140). Counting locally is the source of truth.
   *
   * @param {{ tables: string, fields: string, where?: string, orderBy?: string,
   *           limit?: number, onPage?: (fetched: number, batch: number) => void }} opts
   */
  async cargoQuery(opts) {
    const pageSize = Math.min(opts.limit ?? 500, 500);
    const rows = [];

    for (let offset = 0; ; offset += pageSize) {
      /** @type {Record<string, string|number>} */
      const params = {
        action: 'cargoquery',
        tables: opts.tables,
        fields: opts.fields,
        limit: pageSize,
        offset,
      };
      if (opts.where) params.where = opts.where;
      if (opts.orderBy) params.order_by = opts.orderBy;

      const json = await this.call(params);
      const batch = (json.cargoquery ?? []).map((r) => r.title);
      rows.push(...batch);
      opts.onPage?.(rows.length, batch.length);

      if (batch.length < pageSize) break;
    }

    return rows;
  }

  /**
   * Field schema for a Cargo table — cheap drift detection.
   * @param {string} table
   */
  async cargoFields(table) {
    const json = await this.call({ action: 'cargofields', table });
    return json.cargofields ?? {};
  }

  /**
   * Latest revision id/timestamp for a page — pins the snapshot to a wiki state.
   *
   * Note `lastrevid` only appears when `prop=revisions` is combined with the
   * right props; we ask for both and fall back to a plain page query so a
   * missing revision degrades to `revid: 0` instead of throwing.
   *
   * @param {string} page
   */
  async revisionOf(page) {
    const json = await this.call({
      action: 'query',
      prop: 'revisions',
      titles: page,
      rvprop: 'ids|timestamp',
      rvlimit: 1,
    });
    const p = json.query?.pages?.[0];
    if (!p || p.missing) return null;
    const rev = p.revisions?.[0];
    return {
      page,
      revid: rev?.revid ?? p.lastrevid ?? 0,
      timestamp: rev?.timestamp ?? '',
    };
  }

  /** The wiki's configured main page title, used to pin a revision safely. */
  async mainPage() {
    const json = await this.call({ action: 'query', meta: 'siteinfo', siprop: 'general' });
    return json.query?.general?.mainpage ?? null;
  }
}
