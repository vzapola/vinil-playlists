import { titleSim, bestArtistSim, artistSim, isVarious, baseTitle } from './normalize.js';

export const TH = { track: 0.85, title: 0.8, artist: 0.75 };

// Versão da lógica de matching. Cada resultado guardado leva este carimbo, e o
// cache considera velho o que veio de uma versão anterior. Assim uma melhoria
// alcança sozinha o que já estava salvo, um pedaço por execução, sem obrigar
// o "refazer tudo" — que, com a cota curta do Spotify, nunca chegava ao fim.
// Suba este número sempre que o matching mudar de comportamento.
export const MATCHER_VERSION = 3;

const q = (s) => String(s ?? '').replace(/"/g, '').trim();

// Pareamento guloso faixa a faixa: cada faixa do Discogs pega o melhor candidato ainda livre.
export function matchTracklist(discogsTracks, candidates, getTitle) {
  const used = new Set();
  return discogsTracks.map((dt) => {
    let best = -1;
    let bestS = 0;
    candidates.forEach((c, i) => {
      if (used.has(i)) return;
      const s = titleSim(dt.title, getTitle(c));
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    });
    if (best >= 0 && bestS >= TH.track) {
      used.add(best);
      return { cand: candidates[best], score: bestS };
    }
    return null;
  });
}

// full: todas as faixas do disco achadas no mesmo álbum
// partial: parte das faixas, ou faixas achadas em outros álbuns (coletâneas, reedições)
// none: nada encontrado
export function classify(tracks, albumFound) {
  const n = tracks.length;
  const fromAlbum = tracks.filter((t) => t.match?.source === 'album').length;
  const other = tracks.filter((t) => t.match?.source === 'other').length;
  if (n === 0) return albumFound ? 'full' : 'none';
  if (fromAlbum === n) return 'full';
  if (fromAlbum + other === 0) return 'none';
  return 'partial';
}

function primaryArtist(album) {
  return album.artists.find((a) => !isVarious(a)) || album.artists[0] || '';
}

function summarize(platform, album, matchedAlbum, tracks, extra = {}) {
  const status = classify(tracks, !!matchedAlbum);
  const found = tracks.filter((t) => t.match).length;
  return {
    platform,
    key: album.key,
    status,
    matchedAlbum,
    found,
    total: tracks.length,
    otherAlbums: tracks.filter((t) => t.match?.source === 'other').length,
    tracks,
    checkedAt: Date.now(),
    mv: MATCHER_VERSION,
    ...extra,
  };
}

/* ---------------- Spotify ---------------- */

// barato: uma busca por disco e nenhuma varredura faixa a faixa. Serve para
// a primeira passada sobre uma coleção inteira quando a cota é curta — cobre
// a maioria dos discos pelo preço de um, e o que sobrar fica para uma passada
// completa depois. 149 discos custam 149 chamadas em vez de 555.
export async function matchAlbumSpotify(album, discogsTracks, sp, { barcode, barato = false } = {}) {
  const various = album.artists.some(isVarious);
  const primary = primaryArtist(album);
  const solta = various ? q(album.title) : `${q(album.title)} ${q(primary)}`;
  const queries = [];
  if (barcode) queries.push(`upc:${barcode}`);
  if (barato) {
    // Sem barcode, a frase solta tem mais alcance que o filtro: quem ordena
    // é a relevância do Spotify, e o nosso score decide depois.
    if (!barcode) queries.push(solta);
  } else {
    queries.push(various ? `album:"${q(album.title)}"` : `album:"${q(album.title)}" artist:"${q(primary)}"`);
    queries.push(solta);
  }

  const cands = new Map();
  for (const query of queries) {
    let items = [];
    try {
      items = await sp.searchAlbums(query);
    } catch (e) {
      if (e.status === 400 || e.status === 404) continue;
      throw e;
    }
    const viaUpc = query.startsWith('upc:');
    for (const it of items) {
      if (cands.has(it.id)) continue;
      const tS = titleSim(album.title, it.name);
      const aS = various ? 1 : bestArtistSim(album.artists, (it.artists || []).map((a) => a.name));
      const ok = (tS >= TH.title && aS >= TH.artist) || (viaUpc && aS >= 0.6);
      if (ok) cands.set(it.id, { it, score: tS * 0.6 + aS * 0.4 + (viaUpc ? 0.2 : 0) + (it.album_type === 'album' ? 0.02 : 0) });
    }
    // O código de barras é identidade, não palpite: se ele devolveu disco,
    // não há consulta melhor a fazer. Fora isso, a busca com filtro e a busca
    // solta se complementam (título com pontuação estranha só aparece na
    // segunda), então vale a chamada extra.
    if (cands.size || (viaUpc && items.length)) break;
  }

  let best = null;
  for (const c of [...cands.values()].sort((a, b) => b.score - a.score).slice(0, 2)) {
    const ctracks = await sp.albumTracks(c.it.id);
    const pairs = matchTracklist(discogsTracks, ctracks, (t) => t.name);
    const cov = discogsTracks.length ? pairs.filter(Boolean).length / discogsTracks.length : 1;
    if (!best || cov > best.cov || (cov === best.cov && c.score > best.score)) best = { ...c, ctracks, pairs, cov };
    if (cov === 1) break;
  }

  const matchedAlbum = best
    ? {
        id: best.it.id,
        name: best.it.name,
        artists: (best.it.artists || []).map((a) => a.name).join(', '),
        url: best.it.external_urls?.spotify || '',
        image: best.it.images?.at(-1)?.url || best.it.images?.[0]?.url || '',
        year: (best.it.release_date || '').slice(0, 4),
      }
    : null;

  // Disco sem tracklist no Discogs: usa o álbum inteiro do Spotify.
  if (!discogsTracks.length && best) {
    const tracks = best.ctracks.map((t) => ({
      position: String(t.track_number),
      title: t.name,
      match: spTrack(t, matchedAlbum.name, 'album'),
    }));
    return summarize('spotify', album, matchedAlbum, tracks, { note: 'Sem tracklist no Discogs; usado o álbum do Spotify', esforco: barato ? 'barato' : 'completo' });
  }

  const tracks = discogsTracks.map((dt, i) => ({
    position: dt.position,
    title: dt.title,
    match: best?.pairs[i] ? spTrack(best.pairs[i].cand, matchedAlbum.name, 'album') : null,
  }));

  // Faixas que faltaram: procura a mesma música do mesmo artista em outros álbuns.
  // usedIds impede que várias faixas do mesmo disco apontem para a mesma faixa
  // do Spotify — um 12" com seis remixes de uma música só casaria seis vezes
  // com ela e o disco apareceria como completo, o que seria mentira.
  // Quando nem o álbum foi encontrado, varrer faixa a faixa custa caro e a
  // cota do Spotify é curta. Se algumas faixas seguidas não aparecem, o disco
  // provavelmente não está na plataforma: desiste e segue para o próximo.
  const GIVE_UP_AFTER = 2;
  const MAX_LOOKUPS = barato ? 0 : 8;
  const usedIds = new Set(tracks.map((t) => t.match?.id).filter(Boolean));
  let misses = 0;
  let lookups = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].match) continue;
    if (!best && misses >= GIVE_UP_AFTER) break;
    // Teto por disco mesmo quando o álbum foi achado: um LP de 20 faixas com
    // meia tracklist faltando gastaria sozinho dezenas de buscas, e a cota é
    // de todos os discos. O que sobrar volta na próxima rodada.
    if (lookups >= MAX_LOOKUPS) break;
    lookups++;
    const dt = discogsTracks[i];
    const art = dt.artists.find((a) => !isVarious(a)) || primary;
    const hit = await findTrackElsewhere(sp, dt.title, art, album.title, best?.it.id, usedIds);
    if (hit) {
      tracks[i].match = hit;
      usedIds.add(hit.id);
      misses = 0;
    } else misses++;
  }

  return summarize('spotify', album, matchedAlbum, tracks, { esforco: barato ? 'barato' : 'completo' });
}

async function findTrackElsewhere(sp, title, artist, albumTitle, excludeAlbumId, usedIds = new Set()) {
  // Com sufixo de versão no título ("Good Time (Beasley Metromix)"), procurar
  // o título cheio não acha nada: o que existe no Spotify é a música. Então a
  // busca usa o título base — mas o score continua medido contra o original.
  const base = baseTitle(title);
  const term = base && base !== String(title).trim() ? base : title;
  const queries = artist && !isVarious(artist) ? [`track:"${q(term)}" artist:"${q(artist)}"`, `${q(term)} ${q(artist)}`] : [`track:"${q(term)}"`];
  for (const query of queries) {
    let items = [];
    try {
      items = await sp.searchTracks(query);
    } catch (e) {
      if (e.status === 400 || e.status === 404) continue;
      throw e;
    }
    // Mesma regra dos álbuns: se o Spotify devolveu faixas e nenhuma passou,
    // repetir com a frase solta é gastar chamada no mesmo catálogo.
    const vazio = items.length === 0;
    let best = null;
    for (const t of items) {
      if (t.album?.id === excludeAlbumId || usedIds.has(t.id)) continue;
      const tS = titleSim(title, t.name);
      const aS = artist && !isVarious(artist) ? Math.max(0, ...(t.artists || []).map((a) => artistSim(artist, a.name))) : 1;
      if (tS < TH.track || aS < TH.artist) continue;
      // Prefere a versão de álbum com nome parecido (outra edição do mesmo disco).
      const score = tS + aS * 0.5 + titleSim(albumTitle, t.album?.name || '') * 0.3;
      if (!best || score > best.score) best = { t, score };
    }
    if (best) return spTrack(best.t, best.t.album?.name || '', 'other');
    if (!vazio) break;
  }
  return null;
}

function spTrack(t, albumName, source) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    albumName,
    source,
    url: t.external_urls?.spotify || '',
  };
}

/* ---------------- YouTube ---------------- */

const stripAlbumPrefix = (s) => s.replace(/^(album|álbum|ep|single)\s*[-:–]\s*/i, '');
const stripTopic = (s) => s.replace(/\s*-\s*topic$/i, '').replace(/\s*-\s*tópico$/i, '');
const stripFullAlbum = (s) => s.replace(/[\(\[]\s*(full album|álbum completo|album completo|disco completo)\s*[\)\]]/gi, '').trim();

// "Artista - Faixa" -> "Faixa" quando o prefixo é o artista.
function cleanVideoTitle(title, artists) {
  const m = title.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (m && bestArtistSim(artists, [m[1]]) >= 0.7) return m[2];
  return title;
}

export async function matchAlbumYouTube(album, discogsTracks, yt, { trackSearch = false } = {}) {
  const various = album.artists.some(isVarious);
  const primary = primaryArtist(album);
  const results = await yt.searchPlaylists(various ? album.title : `${primary} ${album.title}`);

  const cands = [];
  for (const p of results) {
    const rawTitle = stripFullAlbum(stripAlbumPrefix(p.title));
    const channel = stripTopic(p.channel);
    const titleVariants = [rawTitle, cleanVideoTitle(rawTitle, album.artists)];
    const tS = Math.max(...titleVariants.map((t) => titleSim(album.title, t)));
    const aS = various ? 1 : Math.max(bestArtistSim(album.artists, [channel]), bestArtistSim(album.artists, [rawTitle.split(/\s[-–—]\s/)[0]]));
    const official = p.id.startsWith('OLAK5uy_');
    if (tS >= TH.title && (aS >= 0.7 || official)) cands.push({ p, score: tS + aS * 0.5 + (official ? 0.3 : 0) });
  }
  cands.sort((a, b) => b.score - a.score);

  let best = null;
  for (const c of cands.slice(0, 2)) {
    const vids = await yt.playlistVideos(c.p.id);
    const pairs = matchTracklist(discogsTracks, vids, (v) => cleanVideoTitle(v.title, album.artists));
    const cov = discogsTracks.length ? pairs.filter(Boolean).length / discogsTracks.length : vids.length ? 1 : 0;
    if (!best || cov > best.cov) best = { ...c, vids, pairs, cov };
    if (cov === 1) break;
  }

  const matchedAlbum = best
    ? {
        id: best.p.id,
        name: stripFullAlbum(stripAlbumPrefix(best.p.title)),
        artists: stripTopic(best.p.channel),
        url: `https://music.youtube.com/playlist?list=${best.p.id}`,
        image: '',
      }
    : null;

  if (!discogsTracks.length && best) {
    const tracks = best.vids.map((v, i) => ({ position: String(i + 1), title: v.title, match: ytTrack(v, matchedAlbum.name, 'album') }));
    return summarize('youtube', album, matchedAlbum, tracks, { note: 'Sem tracklist no Discogs; usada a playlist do álbum' });
  }

  const tracks = discogsTracks.map((dt, i) => ({
    position: dt.position,
    title: dt.title,
    match: best?.pairs[i] ? ytTrack(best.pairs[i].cand, matchedAlbum.name, 'album') : null,
  }));

  // Busca faixa a faixa custa 100 unidades cada; só quando habilitado.
  if (trackSearch) {
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].match) continue;
      const dt = discogsTracks[i];
      const art = dt.artists.find((a) => !isVarious(a)) || primary;
      const vids = await yt.searchVideos(`${art} ${dt.title}`);
      let pick = null;
      for (const v of vids) {
        const tS = titleSim(dt.title, cleanVideoTitle(v.title, [art]));
        const aS = Math.max(artistSim(art, stripTopic(v.channel)), bestArtistSim([art], [v.title.split(/\s[-–—]\s/)[0]]));
        if (tS >= TH.track && aS >= 0.7 && (!pick || tS + aS > pick.s)) pick = { v, s: tS + aS };
      }
      if (pick) tracks[i].match = ytTrack(pick.v, 'vídeo avulso', 'other');
    }
  }

  return summarize('youtube', album, matchedAlbum, tracks, { trackSearch });
}

function ytTrack(v, albumName, source) {
  return {
    id: v.videoId,
    videoId: v.videoId,
    name: v.title,
    albumName,
    source,
    url: `https://music.youtube.com/watch?v=${v.videoId}`,
  };
}
