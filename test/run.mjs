// Testes offline com APIs simuladas: node test/run.mjs
import assert from 'node:assert/strict';
import { titleSim, artistSim, norm } from '../core/normalize.js';
import { matchAlbumSpotify, matchAlbumYouTube, MATCHER_VERSION } from '../core/matcher.js';
import { toAlbum, parseTracklist } from '../core/discogs.js';
import { initCache, matchAll, syncSpotify, syncYouTube, wantedIds } from '../core/pipeline.js';
import { createYouTube, QuotaExhausted } from '../core/youtube.js';
import { createSpotify } from '../core/spotify.js';
import { HttpError } from '../core/http.js';

let pass = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log('ok  ', name);
  } catch (e) {
    console.log('FAIL', name, '\n    ', e.message);
    process.exitCode = 1;
  }
};

/* ---------- normalização ---------- */
await test('acentos e remaster', () => {
  assert.ok(titleSim('Construção', 'Construção (Remasterizado 2006)') > 0.95);
  assert.ok(titleSim('Ponta de Areia', 'Ponta De Areia - Remastered 1994') > 0.95);
});
await test('números diferentes não batem', () => {
  assert.ok(titleSim('Clube da Esquina', 'Clube da Esquina 2') < 0.8);
});
// Casos reais da coleção: sufixos que nenhuma lista de palavras enumera.
await test('sufixo de versão não derruba o pareamento', () => {
  assert.ok(titleSim('Musical', 'Musical - Remixed Original Album') >= 0.85);
  assert.ok(titleSim('Eclipse Oculto', 'Eclipse Oculto - Remixed Original Album') >= 0.85);
  assert.ok(titleSim('Good Time (Beasley Metromix)', 'Good Time') >= 0.85);
  assert.ok(titleSim('Good Time (Nelle\'s 12")', 'Good Time') >= 0.85, 'o 12" do sufixo não pode contar como número do título');
});
await test('título base não atropela discos diferentes', () => {
  assert.ok(titleSim('Clube Da Esquina', 'Clube Da Esquina 2') < 0.8);
  assert.ok(titleSim('Construção', 'Cotidiano') < 0.5);
});
// O Discogs imprime a capa ("Dr. Robert"); o Spotify escreve por extenso.
// Sem expandir, a faixa ficava de fora de um Revolver que existe inteiro lá.
await test('abreviação escrita de dois jeitos é a mesma faixa', () => {
  assert.ok(titleSim('Dr. Robert', 'Doctor Robert - Remastered 2009') >= 0.95);
  assert.ok(titleSim('St. Louis Blues', 'Saint Louis Blues') >= 0.95);
  assert.ok(titleSim('Rock Pt. 2', 'Rock Part 2') >= 0.95);
  assert.ok(titleSim('Dr. Robert', 'Doctor Who') < 0.8, 'expandir não pode colar coisas diferentes');
});
await test('artista Discogs com sufixo e nome longo', () => {
  assert.ok(artistSim('Jorge Ben (2)', 'Jorge Ben') > 0.95);
  assert.ok(artistSim('Chico Buarque De Hollanda', 'Chico Buarque') >= 0.9);
  assert.ok(artistSim('Gal Costa', 'Gilberto Gil') < 0.75);
});
await test('norm remove pontuação', () => {
  assert.equal(norm("Racionais MC's"), 'racionais mc s');
});

/* ---------- Discogs ---------- */
const discogsItem = {
  date_added: '2024-01-01',
  basic_information: {
    id: 111, master_id: 999, title: 'Construção', year: 1971, thumb: 't.jpg', cover_image: 'c.jpg',
    artists: [{ name: 'Chico Buarque', anv: '', join: '' }], formats: [{ name: 'Vinyl' }],
  },
};
const release = {
  artists: [{ name: 'Chico Buarque', anv: '' }],
  tracklist: [
    { type_: 'heading', title: 'Lado A' },
    { type_: 'track', position: 'A1', title: 'Deus Lhe Pague' },
    { type_: 'track', position: 'A2', title: 'Cotidiano' },
    { type_: 'track', position: 'A3', title: 'Desalento' },
    { type_: 'track', position: 'B1', title: 'Construção' },
    { type_: 'track', position: 'B2', title: 'Faixa Rara Do Vinil' },
  ],
};
await test('Discogs: álbum e tracklist', () => {
  const a = toAlbum(discogsItem);
  assert.equal(a.key, 'm999');
  const t = parseTracklist(release);
  assert.equal(t.length, 5);
  assert.deepEqual(t[0].artists, ['Chico Buarque']);
});

/* ---------- Spotify simulado ---------- */
const spAlbum = (id, name, artist, tracks) => ({
  id, name, album_type: 'album', artists: [{ name: artist }], external_urls: { spotify: `https://open.spotify.com/album/${id}` }, images: [], release_date: '1971',
  _tracks: tracks.map((n, i) => ({ id: `${id}_${i}`, uri: `spotify:track:${id}_${i}`, name: n, track_number: i + 1, external_urls: {} })),
});
const SP_ALBUMS = [
  spAlbum('constr', 'Construção (Remasterizado)', 'Chico Buarque', ['Deus Lhe Pague', 'Cotidiano', 'Desalento', 'Construção']),
  spAlbum('clube2', 'Clube Da Esquina 2', 'Milton Nascimento', ['Credo', 'Ruas da Cidade']),
];
const SP_LOOSE = [{ id: 'rara', uri: 'spotify:track:rara', name: 'Faixa Rara do Vinil', artists: [{ name: 'Chico Buarque' }], album: { id: 'colet', name: 'Chico 50 Anos' }, external_urls: {} }];

function mockSpotify() {
  const playlist = { id: 'pl1', name: null, items: [], external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } };
  const created = [];
  // Procurar pelo nome e não achar significa criar outra, vazia: é esse o
  // comportamento que o id fixado evita depois de a playlist já existir.
  const findOrCreate = async (name) => {
    if (playlist.name === name) return playlist;
    playlist.name = name;
    playlist.items = [];
    created.push(name);
    return playlist;
  };
  return {
    playlist,
    created,
    async searchAlbums(q) {
      if (q.startsWith('upc:')) return [];
      return SP_ALBUMS.filter((a) => q.toLowerCase().includes(a.name.split(' ')[0].toLowerCase()));
    },
    async searchTracks(q) {
      return SP_LOOSE.filter((t) => q.toLowerCase().includes('rara'));
    },
    async albumTracks(id) {
      return SP_ALBUMS.find((a) => a.id === id)._tracks;
    },
    findOrCreatePlaylist: findOrCreate,
    async resolvePlaylist({ id, name, rename } = {}) {
      if (id === playlist.id && playlist.name !== null) {
        if (rename && name && playlist.name !== name) playlist.name = name;
        return playlist;
      }
      return findOrCreate(name); // sem id, ou id que não existe mais (404)
    },
    async playlistUris() { return [...playlist.items]; },
    async addItems(id, uris) { playlist.items.push(...uris); },
  };
}

const album = toAlbum(discogsItem);
const tracks = parseTracklist(release);

await test('Spotify: parcial com faixa achada em outro álbum', async () => {
  const r = await matchAlbumSpotify(album, tracks, mockSpotify(), {});
  assert.equal(r.status, 'partial');
  assert.equal(r.found, 5);
  assert.equal(r.otherAlbums, 1);
  assert.equal(r.tracks[4].match.albumName, 'Chico 50 Anos');
  assert.equal(r.matchedAlbum.id, 'constr');
});
await test('Spotify: completo quando todas as faixas estão no álbum', async () => {
  const r = await matchAlbumSpotify(album, tracks.slice(0, 4), mockSpotify(), {});
  assert.equal(r.status, 'full');
});
await test('Spotify: Clube da Esquina não casa com Clube da Esquina 2', async () => {
  const a = toAlbum({ basic_information: { id: 2, master_id: 0, title: 'Clube Da Esquina', artists: [{ name: 'Milton Nascimento' }, { name: 'Lô Borges' }] } });
  const r = await matchAlbumSpotify(a, [{ position: 'A1', title: 'Tudo Que Você Podia Ser', artists: ['Milton Nascimento'] }], mockSpotify(), {});
  assert.equal(r.status, 'none');
});
// Um 12" de remixes: o disco tem seis faixas, o Spotify tem a música uma vez.
await test('Spotify: 12" de remixes casa uma vez só, não seis', async () => {
  const single = { id: 'gt', uri: 'spotify:track:gt', name: 'Good Time', artists: [{ name: 'Ziggy Marley & The Melody Makers' }], album: { id: 'best', name: 'The Best Of Ziggy Marley & The Melody Makers' }, external_urls: {} };
  const sp = {
    async searchAlbums() { return []; }, // o 12" não existe como álbum no Spotify
    async searchTracks() { return [single]; },
    async albumTracks() { return []; },
  };
  const a = toAlbum({ basic_information: { id: 9, master_id: 0, title: 'Good Time', artists: [{ name: 'Ziggy Marley And The Melody Makers' }] } });
  const dtracks = ['Good Time (Beasley Metromix)', 'Good Time (Beasley Instrumental)', 'Good Time (Beasley Percapella)', 'Good Time (Nelle\'s 12")', 'Good Time (Nellee\'s 12" Instrumental)', 'Good Time (LP Version)'].map((title, i) => ({
    position: `A${i + 1}`,
    title,
    artists: ['Ziggy Marley And The Melody Makers'],
  }));
  const r = await matchAlbumSpotify(a, dtracks, sp, {});
  assert.equal(r.found, 1, 'a mesma faixa não pode casar seis vezes');
  assert.equal(r.status, 'partial', 'antes dava "sem match"; seis matches dariam "completo", e os dois seriam mentira');
  assert.equal(r.tracks[0].match.uri, 'spotify:track:gt');
  assert.equal(r.tracks[1].match, null);
});

// Um disco de remixes repete a mesma busca uma vez por faixa. Repetir isso na
// rede, vezes 149 discos, é o que levava a coleção inteira a tomar 429.
await test('Spotify: a mesma busca não vai duas vezes à rede', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ tracks: { items: [] }, albums: { items: [] } }); } };
  };
  try {
    const sp = createSpotify({ getToken: async () => 'tok', minGap: 0 });
    await sp.searchTracks('track:"Good Time"');
    await sp.searchTracks('track:"Good Time"');
    await sp.searchTracks('track:"Good Time"');
    assert.equal(calls, 1, 'as repetições saem do cache');
    await sp.searchTracks('track:"Outra"');
    await sp.searchAlbums('track:"Good Time"'); // tipo diferente, busca diferente
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = real;
  }
});

await test('Pipeline: matchAll + syncSpotify idempotente', async () => {
  const cache = initCache();
  cache.discogs[album.releaseId] = { tracklist: tracks, barcode: null };
  const sp = mockSpotify();
  const { results } = await matchAll({ platform: 'spotify', albums: [album], cache, matchFn: (a, t, rel) => matchAlbumSpotify(a, t, sp, rel) });
  const s1 = await syncSpotify({ albums: [album], results, sp, playlistName: 'x' });
  const s2 = await syncSpotify({ albums: [album], results, sp, playlistName: 'x' });
  assert.equal(s1.added, 5);
  assert.equal(s2.added, 0);
  assert.equal(sp.playlist.items.length, 5);
});

// Um disco que não está na plataforma não pode custar duas buscas por faixa.
await test('Spotify: disco ausente desiste depois de algumas faixas', async () => {
  let buscas = 0;
  const sp = {
    async searchAlbums() { return []; },
    async searchTracks() { buscas++; return []; },
    async albumTracks() { return []; },
  };
  const a = toAlbum({ basic_information: { id: 11, master_id: 0, title: 'Disco Inexistente', artists: [{ name: 'Artista Obscuro' }] } });
  const dtracks = Array.from({ length: 12 }, (_, i) => ({ position: `A${i + 1}`, title: `Faixa ${i + 1}`, artists: ['Artista Obscuro'] }));
  const r = await matchAlbumSpotify(a, dtracks, sp, {});
  assert.equal(r.status, 'none');
  assert.ok(buscas <= 6, `12 faixas não podem custar 24 buscas (foram ${buscas})`);
});

// Estourado o limite, insistir nos outros 148 discos só gera erro e atrasa a
// volta da cota.
await test('Pipeline: 429 para a análise em vez de errar disco por disco', async () => {
  const cache = initCache();
  const albums = [1, 2, 3].map((n) => ({ key: `k${n}`, releaseId: n, artist: 'x', title: `t${n}`, artists: ['x'] }));
  for (const a of albums) cache.discogs[a.releaseId] = { tracklist: [], barcode: null };
  let chamadas = 0;
  const matchFn = async () => {
    chamadas++;
    const e = new Error('Spotify 429: Too many requests');
    e.status = 429;
    throw e;
  };
  const { results, stopped, rateLimited } = await matchAll({ platform: 'spotify', albums, cache, matchFn });
  assert.equal(chamadas, 1, 'para no primeiro disco, não varre os outros');
  assert.ok(/429/.test(stopped), 'o motivo da parada precisa chegar à tela');
  assert.equal(rateLimited, true, 'é o que faz a página abrir a janela de espera');
  assert.ok(!/depois desse tempo/.test(stopped), 'não prometer prazo que não temos');
  assert.equal(Object.keys(results).length, 0);
});

// Sem isto, melhorar o matching não alcançava o que já estava salvo a não ser
// pelo "refazer tudo" — que a cota do Spotify nunca deixava terminar.
await test('Pipeline: resultado de versão antiga do matcher é refeito sozinho', async () => {
  const cache = initCache();
  const a = { key: 'k1', releaseId: 1, artist: 'x', title: 't', artists: ['x'] };
  cache.discogs[1] = { tracklist: [], barcode: null };
  const feito = (mv) => ({ platform: 'spotify', key: a.key, status: 'full', tracks: [], found: 0, total: 0, checkedAt: Date.now(), mv });
  cache.spotify[a.key] = feito(MATCHER_VERSION - 1); // salvo por uma versão anterior

  let chamou = 0;
  const matchFn = async () => {
    chamou++;
    return feito(MATCHER_VERSION);
  };
  const r1 = await matchAll({ platform: 'spotify', albums: [a], cache, matchFn });
  assert.equal(chamou, 1, 'carimbo antigo deve ser refeito mesmo sem "refazer tudo"');
  assert.equal(r1.analyzed, 1);

  const r2 = await matchAll({ platform: 'spotify', albums: [a], cache, matchFn });
  assert.equal(chamou, 1, 'já na versão atual, não gasta cota de novo');
  assert.equal(r2.analyzed, 0, 'reaproveitado não conta como analisado');
  assert.equal(r2.done, 1, 'mas continua valendo como resultado');
});

// Prepara coleção + matches para os testes de playlist fixada.
async function syncFixture() {
  const cache = initCache();
  cache.discogs[album.releaseId] = { tracklist: tracks, barcode: null };
  const sp = mockSpotify();
  const { results } = await matchAll({ platform: 'spotify', albums: [album], cache, matchFn: (a, t, rel) => matchAlbumSpotify(a, t, sp, rel) });
  return { sp, results };
}

await test('Pipeline: playlist fixada por id sobrevive a renomear no Spotify', async () => {
  const { sp, results } = await syncFixture();
  let pin = null;
  const s1 = await syncSpotify({ albums: [album], results, sp, playlistName: 'Vinil', onPlaylist: (p) => (pin = p) });
  assert.equal(s1.added, 5);
  assert.equal(pin.id, 'pl1');

  sp.playlist.name = 'Meus vinis'; // o usuário renomeia dentro do Spotify

  const s2 = await syncSpotify({ albums: [album], results, sp, playlistName: 'Vinil', pinnedId: pin.id });
  assert.equal(s2.added, 0, 'não pode duplicar');
  assert.equal(sp.created.length, 1, 'não pode criar uma segunda playlist');
  assert.equal(sp.playlist.name, 'Meus vinis', 'o nome dado no Spotify é respeitado');
  assert.equal(sp.playlist.items.length, 5);
});

await test('Pipeline: sem id fixado, renomear no Spotify cria outra playlist', async () => {
  const { sp, results } = await syncFixture();
  await syncSpotify({ albums: [album], results, sp, playlistName: 'Vinil' });
  sp.playlist.name = 'Meus vinis';
  const s2 = await syncSpotify({ albums: [album], results, sp, playlistName: 'Vinil' });
  assert.equal(sp.created.length, 2, 'é exatamente o problema que o id fixado resolve');
  assert.equal(s2.added, 5);
});

await test('Pipeline: mudar o nome na página renomeia a playlist fixada', async () => {
  const { sp, results } = await syncFixture();
  let pin = null;
  await syncSpotify({ albums: [album], results, sp, playlistName: 'Vinil', onPlaylist: (p) => (pin = p) });
  const s2 = await syncSpotify({ albums: [album], results, sp, playlistName: 'Coleção', pinnedId: pin.id, rename: true, onPlaylist: (p) => (pin = p) });
  assert.equal(sp.playlist.name, 'Coleção');
  assert.equal(sp.created.length, 1);
  assert.equal(pin.name, 'Coleção');
  assert.equal(s2.added, 0, 'renomear não refaz a playlist');
});

/* ---------- YouTube simulado (via fetch falso para testar cota) ---------- */
function mockFetchYouTube() {
  const inserted = [];
  const fake = async (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace('/youtube/v3', '');
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (p === '/search' && u.searchParams.get('type') === 'playlist')
      return json({ items: [{ id: { playlistId: 'OLAK5uy_constr' }, snippet: { title: 'Album - Construção', channelTitle: 'Chico Buarque - Topic' } }] });
    if (p === '/playlistItems' && opts.method === 'POST') {
      inserted.push(JSON.parse(opts.body).snippet.resourceId.videoId);
      return json({ id: 'x' });
    }
    if (p === '/playlistItems') {
      if (u.searchParams.get('playlistId') === 'mypl') return json({ items: inserted.map((v) => ({ contentDetails: { videoId: v }, snippet: { title: v } })) });
      return json({ items: ['Deus Lhe Pague', 'Cotidiano', 'Desalento', 'Construção', 'Faixa Rara do Vinil'].map((t, i) => ({ contentDetails: { videoId: `v${i}` }, snippet: { title: t } })) });
    }
    if (p === '/playlists') return json({ items: [{ id: 'mypl', snippet: { title: 'Minha coleção' } }] });
    return new Response('{}', { status: 404 });
  };
  return { fake, inserted };
}

await test('YouTube: álbum completo via playlist OLAK', async () => {
  const { fake } = mockFetchYouTube();
  globalThis.fetch = fake;
  const yt = createYouTube({ getToken: async () => 't', budget: 9000 });
  const r = await matchAlbumYouTube(album, tracks, yt);
  assert.equal(r.status, 'full');
  assert.equal(yt.quota.used, 101);
});
await test('YouTube: para quando a cota acaba e retoma depois', async () => {
  const { fake, inserted } = mockFetchYouTube();
  globalThis.fetch = fake;
  const cache = initCache();
  cache.discogs[album.releaseId] = { tracklist: tracks };
  // orçamento para: listar playlists (1) + itens (1) + busca (100) + itens álbum (1) + 2 inserções (100)
  let yt = createYouTube({ getToken: async () => 't', budget: 203 });
  const run = (yt) => syncYouTube({ albums: [album], cache, yt, matchFn: (a, t) => matchAlbumYouTube(a, t, yt), playlistName: 'Minha coleção' });
  const r1 = await run(yt);
  assert.ok(r1.stopped);
  assert.equal(r1.added, 2);
  assert.equal(r1.pending, 3);
  yt = createYouTube({ getToken: async () => 't', budget: 9000 });
  const r2 = await run(yt);
  assert.equal(r2.stopped, null);
  assert.equal(r2.added, 3);
  assert.equal(inserted.length, 5);
  assert.equal(yt.quota.used, 2 + 150); // cache evitou nova busca
});

// Dois 429 diferentes: ritmo (janela de 30 s, esperar resolve) e cota de app
// em Development Mode (saldo, esperar minutos não devolve nada). Tratar os
// dois igual foi o que fez a página mandar esperar 15 min por nada.
await test('Pipeline: cota esgotada não é confundida com excesso de ritmo', async () => {
  const cache = initCache();
  const albums = [1, 2].map((n) => ({ key: `k${n}`, releaseId: n, artist: 'x', title: `t${n}`, artists: ['x'] }));
  for (const a of albums) cache.discogs[a.releaseId] = { tracklist: [], barcode: null };
  const matchFn = async () => {
    throw new HttpError(429, { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } }, 'Spotify');
  };
  const { stopped, quota, rateLimited } = await matchAll({ platform: 'spotify', albums, cache, matchFn });
  assert.equal(quota, true);
  assert.equal(rateLimited, false, 'cota não pode abrir a janela de espera por ritmo');
  assert.ok(/QUOTA_EXCEEDED/.test(stopped), 'o motivo cru precisa aparecer, não um palpite');
});

await test('HTTP: cota esgotada não gasta retentativa', async () => {
  const antes = globalThis.fetch;
  let tentativas = 0;
  globalThis.fetch = async () => {
    tentativas++;
    return new Response(JSON.stringify({ error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const sp = createSpotify({ getToken: async () => 't', minGap: 0 });
    await assert.rejects(() => sp.api('/search'), (e) => e.quotaExceeded === true);
    assert.equal(tentativas, 1, 'insistir contra cota esgotada só gasta mais cota');
  } finally {
    globalThis.fetch = antes;
  }
});

// Com a cota curta, varrer 149 discos de uma vez era o jeito mais rápido de
// nunca terminar nenhum. O lote faz cada clique avançar um pedaço.
await test('Pipeline: lote analisa só o combinado e guarda o resto', async () => {
  const cache = initCache();
  const albums = [1, 2, 3, 4, 5].map((n) => ({ key: `k${n}`, releaseId: n, artist: 'x', title: `t${n}`, artists: ['x'] }));
  for (const a of albums) cache.discogs[a.releaseId] = { tracklist: [], barcode: null };
  let chamou = 0;
  const matchFn = async (a) => {
    chamou++;
    return { platform: 'spotify', key: a.key, status: 'full', tracks: [], found: 0, total: 0, checkedAt: Date.now(), mv: MATCHER_VERSION };
  };
  const r1 = await matchAll({ platform: 'spotify', albums, cache, matchFn, limit: 2 });
  assert.equal(chamou, 2, 'o lote vale');
  assert.equal(r1.analyzed, 2);
  assert.equal(r1.adiados, 3);

  const r2 = await matchAll({ platform: 'spotify', albums, cache, matchFn, limit: 2 });
  assert.equal(chamou, 4, 'a rodada seguinte continua de onde parou, sem refazer');
  assert.equal(r2.adiados, 1);

  await matchAll({ platform: 'spotify', albums, cache, matchFn, limit: 2 });
  assert.equal(chamou, 5, 'o último disco fecha a coleção');
});

// Número medido no cache real da coleção: um disco que não existe no Spotify
// custava 8,3 chamadas e passou a custar 3. Com 149 discos, é a diferença
// entre 1231 e 555 chamadas por varredura completa.
await test('Spotify: disco ausente cabe num orçamento pequeno de chamadas', async () => {
  let buscas = 0;
  const ruido = (n) => Array.from({ length: 10 }, (_, i) => ({
    id: 'x' + i, uri: 'u' + i, name: n + i, artists: [{ name: 'Outro ' + i }],
    album: { id: 'z' + i, name: 'Outro' }, external_urls: {}, images: [],
  }));
  const sp = {
    searchAlbums: async () => (buscas++, ruido('Album ')),
    searchTracks: async () => (buscas++, ruido('Faixa ')),
    albumTracks: async () => [],
  };
  const album = { key: 'k', title: 'Disco Que Nao Existe', artists: ['Artista Inexistente'] };
  const tl = Array.from({ length: 10 }, (_, i) => ({ position: 'A' + i, title: 'Faixa ' + i, artists: ['Artista Inexistente'] }));
  const r = await matchAlbumSpotify(album, tl, sp, {});
  assert.equal(r.status, 'none');
  assert.ok(buscas <= 4, `um disco ausente não pode custar ${buscas} buscas`);
});

// Busca e playlist são baldes de cota diferentes: a primeira pode estar
// esgotada e a segunda viva. Perder o que já estava casado por causa disso
// deixava a coleção meio resolvida sem nenhuma playlist para ouvir.
await test('Pipeline: 429 na análise não apaga o que já estava casado', async () => {
  const cache = initCache();
  const albums = [1, 2, 3].map((n) => ({ key: `k${n}`, releaseId: n, artist: 'x', title: `t${n}`, artists: ['x'] }));
  for (const a of albums) cache.discogs[a.releaseId] = { tracklist: [], barcode: null };
  // salvos por uma versão anterior do matcher: velhos para reanálise, bons para tocar
  for (const a of albums.slice(1)) {
    cache.spotify[a.key] = {
      platform: 'spotify', key: a.key, status: 'full', mv: MATCHER_VERSION - 1, checkedAt: Date.now(), found: 1, total: 1,
      tracks: [{ position: 'A1', title: 'f', match: { id: 'id' + a.key, uri: 'spotify:track:' + a.key, name: 'f', source: 'album' } }],
    };
  }
  const matchFn = async () => {
    throw new HttpError(429, { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } }, 'Spotify');
  };
  const { results, quota, reaproveitados } = await matchAll({ platform: 'spotify', albums, cache, matchFn });
  assert.equal(quota, true);
  assert.equal(reaproveitados, 2, 'os dois que tinham cache entram; o que nunca foi analisado não inventa resultado');
  const uris = wantedIds(albums, results, 'uri');
  assert.deepEqual(uris, ['spotify:track:k2', 'spotify:track:k3'], 'o que já estava casado tem de chegar à playlist');
});

console.log(`\n${pass} testes passaram`);
