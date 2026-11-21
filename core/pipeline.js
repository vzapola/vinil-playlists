import { QuotaExhausted } from './youtube.js';
import { MATCHER_VERSION } from './matcher.js';

const DAY = 86_400_000;

// Por quanto tempo um resultado não-completo fica em cache antes de tentar de novo.
export const TTL_DAYS = { spotify: 7, youtube: 30 };

export function initCache(data) {
  const c = data && data.v === 1 ? data : { v: 1 };
  c.discogs ||= {};
  c.spotify ||= {};
  c.youtube ||= {};
  c.playlist ||= {}; // { spotify: {id, name} } — fixa a playlist entre execuções
  return c;
}

export function isFresh(entry, platform) {
  if (!entry) return false;
  // Resultado de uma versão anterior do matcher conta como velho: é isso que
  // faz as melhorias alcançarem o que já está salvo, aos poucos, a cada
  // execução, em vez de exigir um "refazer tudo" que a cota não deixa terminar.
  if (entry.mv !== MATCHER_VERSION) return false;
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
  let analyzed = 0; // só os que passaram pelo matcher, sem contar os reaproveitados
  let rateLimited = false;
  for (let i = 0; i < albums.length; i++) {
    const a = albums[i];
    const cached = cache[platform][a.key];
    if (!force && isFresh(cached, platform)) {
      results[a.key] = cached;
    } else {
      const rel = cache.discogs[a.releaseId] || { tracklist: [], barcode: null };
      try {
        results[a.key] = await matchFn(a, rel.tracklist || [], rel);
        analyzed++;
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          stopped = e.message;
          break;
        }
        // 429 que sobreviveu às retentativas: o limite do Spotify estourou.
        // Insistir nos discos seguintes só produz mais erro e atrasa a volta
        // da cota. O que já foi analisado está salvo e a próxima execução
        // continua de onde parou.
        if (e.status === 429) {
          // Sem prometer prazo: o Retry-After do Spotify não chega ao
          // navegador (não vem em Access-Control-Expose-Headers). Quem diz
          // quando voltar é a espera que a própria página controla.
          const pedido = e.retryAfter ? ` O Spotify pediu ${waitLabel(e.retryAfter)} de espera.` : '';
          const feitos = analyzed
            ? `${analyzed} ${analyzed === 1 ? 'disco analisado' : 'discos analisados'} nesta rodada, já salvos.`
            : 'Nenhum disco chegou a ser analisado nesta rodada.';
          stopped = `O Spotify limitou as chamadas (429).${pedido} ${feitos}`;
          rateLimited = true;
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
  return { results, stopped, analyzed, rateLimited, done: Object.keys(results).length };
}

function waitLabel(seconds) {
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return h === 1 ? 'cerca de 1 hora' : `cerca de ${h} horas`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return m === 1 ? 'cerca de 1 minuto' : `cerca de ${m} minutos`;
  }
  return `${Math.round(seconds)} segundos`;
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
// pinnedId é o id guardado da playlist; com ele, renomear a playlist dentro do
// Spotify não faz um segundo sync criar outra. onPlaylist devolve {id, name}
// para quem chamou guardar.
export async function syncSpotify({ albums, results, sp, playlistName, description, pinnedId, rename = false, onPlaylist, onProgress }) {
  const pl = await sp.resolvePlaylist({ id: pinnedId, name: playlistName, description, rename });
  const name = pl.name || playlistName;
  onPlaylist?.({ id: pl.id, name });
  const existing = new Set(await sp.playlistUris(pl.id));
  const want = wantedIds(albums, results, 'uri');
  const missing = want.filter((u) => !existing.has(u));
  if (missing.length) await sp.addItems(pl.id, missing, onProgress);
  return { playlistId: pl.id, playlistName: name, url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`, added: missing.length, total: want.length };
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
