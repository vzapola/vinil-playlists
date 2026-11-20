// Testes offline com APIs simuladas: node test/run.mjs
import assert from 'node:assert/strict';
import { titleSim, artistSim, norm } from '../core/normalize.js';
import { matchAlbumSpotify, matchAlbumYouTube } from '../core/matcher.js';
import { toAlbum, parseTracklist } from '../core/discogs.js';
import { initCache, matchAll, syncSpotify, syncYouTube } from '../core/pipeline.js';
import { createYouTube, QuotaExhausted } from '../core/youtube.js';

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
  const playlist = { id: 'pl1', items: [] };
  return {
    playlist,
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
    async findOrCreatePlaylist() { return { id: playlist.id, external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } }; },
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

console.log(`\n${pass} testes passaram`);
