/**
 * Auto-sync: publish the dashboard's watchlists + mailing lists to a private
 * ("secret") GitHub Gist, and read them back in the scheduled email job.
 *
 * Why a gist: a static GitHub Pages site has no server, so the only way for the
 * server-side email job to "pick up" what you saved in the browser is for the
 * browser to publish it somewhere online. A secret gist needs only a classic
 * token scoped to `gist` — it cannot touch your code or repo secrets, so it is
 * the smallest-blast-radius credential to leave non-expiring.
 *
 * The committed watchlist.json / MAILING_LISTS secret remain as a fallback the
 * job uses only when the gist is unreachable.
 */
import { exportPublicWatchlist, exportMailingLists } from './app-core.js';

export const GIST_DESCRIPTION =
  'minervini-dashboard sync (watchlists + mailing lists) — auto-written by the dashboard';

export const GIST_FILE = {
  watchlistUS: 'watchlist.us.json',
  watchlistIN: 'watchlist.in.json',
  mailingUS: 'mailing.us.json',
  mailingIN: 'mailing.in.json',
};

/**
 * Build the Gist `files` map from one or both market collections.
 * @param {{US?: object, IN?: object}} collections
 * @returns {Record<string, {content: string}>}
 */
export function buildGistFiles(collections = {}) {
  const files = {};
  const add = (col, wlName, mlName) => {
    if (!col) return;
    files[wlName] = { content: JSON.stringify(exportPublicWatchlist(col), null, 2) };
    files[mlName] = { content: JSON.stringify(exportMailingLists(col), null, 2) };
  };
  add(collections.US, GIST_FILE.watchlistUS, GIST_FILE.mailingUS);
  add(collections.IN, GIST_FILE.watchlistIN, GIST_FILE.mailingIN);
  return files;
}

export function gistApiUrl(id) {
  return id ? `https://api.github.com/gists/${id}` : 'https://api.github.com/gists';
}

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `token ${token}`;
  return h;
}

/**
 * Create (no id) or update (id) a secret gist with the given files.
 * @param {{token:string, gistId?:string|null, files:object, description?:string, fetchImpl?:typeof fetch}} o
 * @returns {Promise<{id:string, htmlUrl?:string}>}
 */
export async function publishGist({ token, gistId = null, files, description = GIST_DESCRIPTION, fetchImpl } = {}) {
  if (!token) throw new Error('A GitHub token (gist scope) is required to publish.');
  const f = fetchImpl || fetch;
  const url = gistApiUrl(gistId);
  const method = gistId ? 'PATCH' : 'POST';
  const payload = gistId ? { files } : { description, public: false, files };
  const res = await f(url, {
    method,
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `GitHub API ${res.status}`;
    try { const j = await res.json(); if (j && j.message) msg += `: ${j.message}`; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const json = await res.json();
  return { id: json.id, htmlUrl: json.html_url };
}

/** Parse a Gist API response into { filename: parsedJSON }, skipping non-JSON files. */
export function parseGistFiles(gistJson) {
  const out = {};
  const files = (gistJson && gistJson.files) || {};
  for (const [name, file] of Object.entries(files)) {
    if (!file || typeof file.content !== 'string') continue;
    try { out[name] = JSON.parse(file.content); } catch { /* skip non-JSON */ }
  }
  return out;
}

/** Read a (secret) gist by id and return its parsed JSON files. */
export async function readGistFiles(gistId, { fetchImpl, token } = {}) {
  if (!gistId) throw new Error('A gist id is required to read.');
  const f = fetchImpl || fetch;
  const res = await f(gistApiUrl(gistId), { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} reading gist ${gistId}`);
  return parseGistFiles(await res.json());
}

// ---------- email-job source preference (gist first, committed/env backup) ----------

/** Prefer the gist watchlist when it is a valid collection (lists array); else committed. */
export function selectWatchlistSource(gistParsed, committedParsed) {
  if (gistParsed && Array.isArray(gistParsed.lists)) return gistParsed;
  return committedParsed;
}

/** Prefer the gist mailing object (including an intentional empty {}); else env. */
export function selectMailingSource(gistParsed, envParsed) {
  if (gistParsed && typeof gistParsed === 'object' && !Array.isArray(gistParsed)) return gistParsed;
  return envParsed || {};
}
