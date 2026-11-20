import { fetchJson, sleep } from './http.js';
import { cleanDiscogsArtist } from './normalize.js';

const BASE = 'https://api.discogs.com';

// Sem token: ~25 req/min. Com token pessoal: ~60 req/min.
export function createDiscogs({ token, userAgent } = {}) {
  const minGap = token ? 1100 : 2500;
  let last = 0;

  async function get(path, params = {}) {
    const wait = last + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    // token via query string evita preflight CORS no navegador
    if (token) u.searchParams.set('token', token);
    const headers = userAgent ? { 'User-Agent': userAgent } : {};
    return fetchJson(u, { headers }, { label: 'Discogs' });
  }

  async function getCollection(username, onProgress) {
    const raw = [];
    let page = 1;
    let pages = 1;
    do {
      const data = await get(`/users/${encodeURIComponent(username)}/collection/folders/0/releases`, {
        per_page: 100,
        page,
        sort: 'added',
        sort_order: 'asc',
      });
      raw.push(...(data.releases || []));
      pages = data.pagination?.pages || 1;
      onProgress?.(page, pages);
      page++;
    } while (page <= pages);
    return dedupeAlbums(raw.map(toAlbum));
  }

  async function getRelease(id) {
    const r = await get(`/releases/${id}`);
    return {
      tracklist: parseTracklist(r),
      barcode: extractBarcode(r),
    };
  }

  return { get, getCollection, getRelease };
}

export function toAlbum(item) {
  const b = item.basic_information || item;
  const artists = [];
  for (const a of b.artists || []) {
    const n = cleanDiscogsArtist(a.name);
    if (n && !artists.includes(n)) artists.push(n);
    const anv = cleanDiscogsArtist(a.anv);
    if (anv && !artists.includes(anv)) artists.push(anv);
  }
  const display = (b.artists || [])
    .map((a) => cleanDiscogsArtist(a.anv || a.name) + (a.join ? ` ${a.join}` : ''))
    .join(' ')
    .replace(/\s+,/g, ',')
    .trim();
  return {
    key: b.master_id ? `m${b.master_id}` : `r${b.id}`,
    releaseId: b.id,
    masterId: b.master_id || null,
    title: b.title,
    artists,
    artist: display || artists[0] || '',
    year: b.year || null,
    thumb: b.thumb || '',
    cover: b.cover_image || b.thumb || '',
    formats: (b.formats || []).map((f) => f.name).join(', '),
    addedAt: item.date_added || null,
  };
}

// Duas prensagens do mesmo álbum (mesmo master) viram uma entrada só.
export function dedupeAlbums(albums) {
  const seen = new Map();
  for (const a of albums) if (!seen.has(a.key)) seen.set(a.key, a);
  return [...seen.values()];
}

export function parseTracklist(release) {
  const fallback = (release.artists || []).map((a) => cleanDiscogsArtist(a.anv || a.name));
  const out = [];
  for (const t of release.tracklist || []) {
    if (t.type_ === 'heading') continue;
    if (!t.title) continue;
    out.push({
      position: t.position || '',
      title: t.title,
      artists: t.artists?.length ? t.artists.map((a) => cleanDiscogsArtist(a.anv || a.name)) : fallback,
      duration: t.duration || '',
    });
  }
  return out;
}

function extractBarcode(release) {
  for (const id of release.identifiers || []) {
    if (id.type !== 'Barcode') continue;
    const digits = String(id.value || '').replace(/\D/g, '');
    if (digits.length === 12 || digits.length === 13) return digits;
  }
  return null;
}
