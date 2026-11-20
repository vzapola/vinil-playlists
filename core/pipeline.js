import { QuotaExhausted } from './youtube.js';

const DAY = 86_400_000;

// Por quanto tempo um resultado não-completo fica em cache antes de tentar de novo.
export const TTL_DAYS = { spotify: 7, youtube: 30 };

export function initCache(data) {
  const c = data && data.v === 1 ? data : { v: 1 };
  c.discogs ||= {};
  c.spotify ||= {};
  c.youtube ||= {};
  return c;
}

export function isFresh(entry, platform) {
  if (!entry) return false;
  if (entry.status === 'full') return true;
  return Date.now() - (entry.checkedAt || 0) < TTL_DAYS[platform] * DAY;
}

export async function loadTracklists({ albums, discogs, cache, onProgress, onSave }) {
  let done = 0;
  for (const a of albums) {
    if (!cache.discogs[a.releaseId]) {
      cache.discogs[a.releaseId] = await discogs.getRelease(a.releaseId);
      onSave?.();
    }
    onProgress?.(++done, albums.length, a);
  }
}

// Roda o matching álbum a álbum, reaproveitando o cache.
// Se a cota do YouTube acabar, para e devolve o que já tem (stopped: true).
export async function matchAll({ platform, albums, cache, matchFn, force = false, onResult, onProgress, onSave }) {
  const results = {};
  let stopped = null;
  for (let i = 0; i < albums.length; i++) {
    const a = albums[i];
    const cached = cache[platform][a.key];
    if (!force && isFresh(cached, platform)) {
      results[a.key] = cached;
    } else {
      const rel = cache.discogs[a.releaseId] || { tracklist: [], barcode: null };
      try {
        results[a.key] = await matchFn(a, rel.tracklist || [], rel);
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          stopped = e.message;
          break;
        }
        results[a.key] = errorResult(platform, a, e);
      }
      if (results[a.key].status !== 'error') cache[platform][a.key] = results[a.key];
      onSave?.();
    }
    onResult?.(a, results[a.key]);
    onProgress?.(i + 1, albums.length, a);
  }
  return { results, stopped };
}

function errorResult(platform, album, e) {
  return { platform, key: album.key, status: 'error', error: String(e.message || e), tracks: [], found: 0, total: 0, checkedAt: Date.now() };
}

// Ids a inserir, na ordem da coleção e da tracklist, sem repetir.
export function wantedIds(albums, results, field) {
  const out = [];
  const seen = new Set();
  for (const a of albums) {
    for (const t of results[a.key]?.tracks || []) {
      const id = t.match?.[field];
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// Spotify: só adiciona o que ainda não está na playlist (idempotente).
export async function syncSpotify({ albums, results, sp, playlistName, description, onProgress }) {
  const pl = await sp.findOrCreatePlaylist(playlistName, description);
  const existing = new Set(await sp.playlistUris(pl.id));
  const want = wantedIds(albums, results, 'uri');
  const missing = want.filter((u) => !existing.has(u));
  if (missing.length) await sp.addItems(pl.id, missing, onProgress);
  return { playlistId: pl.id, url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`, added: missing.length, total: want.length };
}

// YouTube: álbum a álbum, faz o matching (se precisar) e já insere as faixas.
// Assim a playlist vai ficando completa disco por disco enquanto a cota permitir.
export async function syncYouTube({ albums, cache, yt, matchFn, playlistName, description, onProgress, onSave, onResult }) {
  const pl = await yt.findOrCreatePlaylist(playlistName, description);
  const existing = new Set((await yt.playlistVideos(pl.id)).map((v) => v.videoId));
  let added = 0;
  let pending = 0;
  let stopped = null;
  const results = {};
  try {
    for (let i = 0; i < albums.length; i++) {
      const a = albums[i];
      let r = cache.youtube[a.key];
      if (!isFresh(r, 'youtube')) {
        const rel = cache.discogs[a.releaseId] || { tracklist: [] };
        r = await matchFn(a, rel.tracklist || [], rel);
        cache.youtube[a.key] = r;
        onSave?.();
      }
      results[a.key] = r;
      onResult?.(a, r);
      for (const t of r.tracks) {
        const vid = t.match?.videoId;
        if (!vid || existing.has(vid)) continue;
        await yt.addVideo(pl.id, vid);
        existing.add(vid);
        added++;
      }
      onProgress?.(i + 1, albums.length, a);
    }
  } catch (e) {
    if (!(e instanceof QuotaExhausted)) throw e;
    stopped = e.message;
    const want = wantedIds(albums, { ...cache.youtube, ...results }, 'videoId');
    pending = want.filter((v) => !existing.has(v)).length;
  }
  return { playlistId: pl.id, url: `https://music.youtube.com/playlist?list=${pl.id}`, added, pending, stopped, quota: { ...yt.quota } };
}
