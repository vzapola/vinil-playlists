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

// Ordem dos esforços. Resultado guardado por um esforço menor que o desta
// rodada conta como velho, desde que não esteja completo: é isso que faz a
// passada a fundo alcançar os parciais que o teto da passada completa deixou
// pela metade. Entrada antiga, sem carimbo, vale como 'completo'.
const NIVEL = { barato: 1, completo: 2, fundo: 3 };

export function isFresh(entry, platform, esforco = 'completo') {
  if (!entry) return false;
  // Resultado de uma versão anterior do matcher conta como velho: é isso que
  // faz as melhorias alcançarem o que já está salvo, aos poucos, a cada
  // execução, em vez de exigir um "refazer tudo" que a cota não deixa terminar.
  if (entry.mv !== MATCHER_VERSION) return false;
  // Disco inteiro já está certo, não importa quanto custou achá-lo.
  if (entry.status === 'full') return true;
  if ((NIVEL[esforco] || 2) > (NIVEL[entry.esforco] || 2)) return false;
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
// limit é o tamanho do lote: quantos discos esta rodada pode analisar de novo.
// A cota do Spotify em Development Mode é curta e opaca, então varrer a
// coleção inteira de uma vez é o jeito mais rápido de não terminar nenhuma
// vez. Com lote, cada clique avança um pedaço e o progresso fica salvo.
export async function matchAll({ platform, albums, cache, matchFn, force = false, limit = 0, esforco = 'completo', onResult, onProgress, onSave }) {
  const results = {};
  let stopped = null;
  let analyzed = 0; // só os que passaram pelo matcher, sem contar os reaproveitados
  let adiados = 0; // ficaram para a próxima rodada por causa do lote
  let rateLimited = false;
  let quota = false;
  // Segundos que o Spotify pediu de espera. No navegador nunca chega (o
  // cabeçalho não atravessa o CORS); no servidor, chega — e é o único número
  // real que existe sobre quando a cota volta.
  let retryAfter = 0;
  for (let i = 0; i < albums.length; i++) {
    const a = albums[i];
    const cached = cache[platform][a.key];
    if (!force && isFresh(cached, platform, esforco)) {
      results[a.key] = cached;
    } else if (limit && analyzed >= limit) {
      // Fora do lote: mostra o que já havia salvo, sem gastar chamada.
      if (cached) results[a.key] = cached;
      adiados++;
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
        if (e.status === 429) {
          const feitos = analyzed
            ? `${analyzed} ${analyzed === 1 ? 'disco analisado' : 'discos analisados'} nesta rodada, já salvos.`
            : 'Nenhum disco chegou a ser analisado nesta rodada.';
          // Dois 429 diferentes. O de cota ("QUOTA_EXCEEDED") é saldo de app
          // em Development Mode: não é pressa, e esperar minutos não devolve
          // nada. O outro é ritmo, e aí esperar resolve.
          retryAfter = e.retryAfter || 0;
          if (e.quotaExceeded) {
            quota = true;
            stopped = `A cota de buscas do app do Spotify acabou (429 QUOTA_EXCEEDED). ${feitos}`;
          } else {
            rateLimited = true;
            const pedido = e.retryAfter ? ` O Spotify pediu ${waitLabel(e.retryAfter)} de espera.` : '';
            stopped = `O Spotify limitou o ritmo das chamadas (429).${pedido} ${feitos}`;
          }
          break;
        }
        results[a.key] = errorResult(platform, a, e);
      }
      if (results[a.key].status !== 'error') cache[platform][a.key] = results[a.key];
      onSave?.();
    }
    if (results[a.key]) onResult?.(a, results[a.key]);
    onProgress?.(i + 1, albums.length, a);
  }
  // Parou no meio, ou o lote não alcançou o fim: o que já estava salvo continua
  // valendo para montar a playlist, mesmo vindo de uma versão anterior do
  // matcher. Melhorar o matching não pode fazer a playlist regredir, e uma
  // cota esgotada numa busca não é motivo para não escrever o que já se sabe.
  let reaproveitados = 0;
  for (const a of albums) {
    if (results[a.key]) continue;
    const c = cache[platform][a.key];
    if (c) {
      results[a.key] = c;
      reaproveitados++;
    }
  }
  return { results, stopped, analyzed, adiados, reaproveitados, rateLimited, quota, retryAfter, done: Object.keys(results).length };
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
