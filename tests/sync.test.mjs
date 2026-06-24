// Tests for js/sync.js — written BEFORE the module (TDD).
// Covers gist payload building, API URL/headers, publish (create vs update),
// reading/parsing gist files, and the email-job source-preference helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIST_FILE, buildGistFiles, gistApiUrl, publishGist, parseGistFiles,
  readGistFiles, selectWatchlistSource, selectMailingSource,
} from '../js/sync.js';
import { emptyCollection, createWatchlist, setActiveItems, addSubscriber } from '../js/app-core.js';

function colWith(items, subs = []) {
  let c = emptyCollection();                 // has a "Default" list
  c = setActiveItems(c, items);
  for (const e of subs) c = addSubscriber(c, c.activeName, e);
  return c;
}

describe('buildGistFiles', () => {
  test('emits watchlist + mailing files per provided market, content is valid JSON', () => {
    const US = colWith([{ symbol: 'AAPL' }, { symbol: 'MSFT', entryPrice: 100 }], ['a@x.com']);
    const files = buildGistFiles({ US });
    assert.ok(files[GIST_FILE.watchlistUS] && files[GIST_FILE.mailingUS]);
    const wl = JSON.parse(files[GIST_FILE.watchlistUS].content);
    assert.equal(wl.version, 3);
    assert.equal(wl.lists[0].items.length, 2);
    const ml = JSON.parse(files[GIST_FILE.mailingUS].content);
    assert.deepEqual(ml[US.activeName], ['a@x.com']);
  });
  test('only includes markets that are supplied', () => {
    const files = buildGistFiles({ US: colWith([{ symbol: 'AAPL' }]) });
    assert.ok(!(GIST_FILE.watchlistIN in files));
    assert.ok(!(GIST_FILE.mailingIN in files));
  });
  test('mailing file is an empty object when there are no subscribers (respected, not omitted-to-undefined)', () => {
    const files = buildGistFiles({ US: colWith([{ symbol: 'AAPL' }]) });
    assert.deepEqual(JSON.parse(files[GIST_FILE.mailingUS].content), {});
  });
});

describe('gistApiUrl', () => {
  test('collection vs single-gist endpoints', () => {
    assert.equal(gistApiUrl(), 'https://api.github.com/gists');
    assert.equal(gistApiUrl('abc123'), 'https://api.github.com/gists/abc123');
  });
});

describe('publishGist', () => {
  function fakeFetch(captured, { ok = true, status = 200, id = 'gist1' } = {}) {
    return async (url, opts) => {
      captured.url = url; captured.opts = opts;
      return { ok, status, json: async () => (ok ? { id, html_url: `https://gist.github.com/${id}` } : { message: 'bad' }) };
    };
  }
  test('no gistId -> POST create with public:false and auth header; returns id', async () => {
    const cap = {};
    const files = buildGistFiles({ US: colWith([{ symbol: 'AAPL' }]) });
    const out = await publishGist({ token: 'tok', files, fetchImpl: fakeFetch(cap) });
    assert.equal(out.id, 'gist1');
    assert.equal(cap.url, 'https://api.github.com/gists');
    assert.equal(cap.opts.method, 'POST');
    assert.match(cap.opts.headers.Authorization, /tok/);
    const body = JSON.parse(cap.opts.body);
    assert.equal(body.public, false);
    assert.ok(body.files[GIST_FILE.watchlistUS]);
  });
  test('with gistId -> PATCH update to /gists/{id}, no public flag needed', async () => {
    const cap = {};
    const files = buildGistFiles({ US: colWith([{ symbol: 'AAPL' }]) });
    await publishGist({ token: 'tok', gistId: 'abc', files, fetchImpl: fakeFetch(cap, { id: 'abc' }) });
    assert.equal(cap.url, 'https://api.github.com/gists/abc');
    assert.equal(cap.opts.method, 'PATCH');
  });
  test('missing token throws (never silently no-ops)', async () => {
    await assert.rejects(() => publishGist({ files: {}, fetchImpl: async () => ({}) }), /token/i);
  });
  test('API error surfaces the GitHub message', async () => {
    const cap = {};
    await assert.rejects(
      () => publishGist({ token: 't', files: {}, fetchImpl: fakeFetch(cap, { ok: false, status: 403 }) }),
      /403|bad/
    );
  });
});

describe('parseGistFiles / readGistFiles', () => {
  const gistJson = {
    files: {
      'watchlist.us.json': { content: JSON.stringify({ version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'AAPL' }] }] }) },
      'mailing.us.json': { content: JSON.stringify({ Default: ['a@x.com'] }) },
      'notes.txt': { content: 'not json' },
    },
  };
  test('parseGistFiles parses JSON files, skips non-JSON', () => {
    const m = parseGistFiles(gistJson);
    assert.ok(m['watchlist.us.json'].lists);
    assert.deepEqual(m['mailing.us.json'], { Default: ['a@x.com'] });
    assert.ok(!('notes.txt' in m));
  });
  test('readGistFiles GETs /gists/{id} and returns the parsed map', async () => {
    let calledUrl = null;
    const fetchImpl = async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => gistJson }; };
    const m = await readGistFiles('gid', { fetchImpl });
    assert.equal(calledUrl, 'https://api.github.com/gists/gid');
    assert.ok(m['watchlist.us.json']);
  });
  test('readGistFiles throws a clear error on 404', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    await assert.rejects(() => readGistFiles('missing', { fetchImpl }), /404/);
  });
});

describe('email-job source preference (gist first, committed/env as backup)', () => {
  const gistWl = { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'NVDA' }] }] };
  const committedWl = { version: 3, activeName: 'Default', lists: [{ name: 'Default', items: [{ symbol: 'AAPL' }] }] };
  test('watchlist: prefer gist when it has a lists array', () => {
    assert.equal(selectWatchlistSource(gistWl, committedWl), gistWl);
  });
  test('watchlist: fall back to committed when gist file absent/garbage', () => {
    assert.equal(selectWatchlistSource(undefined, committedWl), committedWl);
    assert.equal(selectWatchlistSource({ nope: 1 }, committedWl), committedWl);
  });
  test('watchlist: an intentionally-empty gist list (lists:[]) is respected over committed', () => {
    const emptyGist = { version: 3, activeName: 'Default', lists: [] };
    assert.equal(selectWatchlistSource(emptyGist, committedWl), emptyGist);
  });
  test('mailing: prefer gist object including an empty {} (means no subscribers)', () => {
    assert.deepEqual(selectMailingSource({}, { Default: ['old@x.com'] }), {});
    assert.deepEqual(selectMailingSource({ A: ['n@x.com'] }, {}), { A: ['n@x.com'] });
  });
  test('mailing: fall back to env when gist file absent', () => {
    assert.deepEqual(selectMailingSource(undefined, { Default: ['e@x.com'] }), { Default: ['e@x.com'] });
  });
});
