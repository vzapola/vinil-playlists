import { fetchJson, sleep } from './http.js';

const API = 'https://api.spotify.com/v1';

// Uma coleção grande dispara mais de mil chamadas. Sem freio, o Spotify
// responde 429 e o disco inteiro vira erro, então as chamadas são espaçadas.
// A cada 429 que escapa das retentativas o espaçamento dobra e não volta,
// para a análise desacelerar sozinha em vez de insistir e falhar.
const MIN_GAP_MS = 200;
const MAX_GAP_MS = 3000;

// Endpoints válidos para apps em Development Mode após as mudanças de 2026:
// POST /me/playlists, GET/POST /playlists/{id}/items, GET /search (limit máx. 10).
export function createSpotify({ getToken, minGap = MIN_GAP_MS, onThrottle } = {}) {
  let gap = minGap;
  let last = 0;

  async function api(path, { method = 'GET', body, params } = {}) {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const token = await getToken();
    const u = new URL(path.startsWith('http') ? path : API + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetchJson(u, { method, headers, body: body ? JSON.stringify(body) : undefined }, { label: 'Spotify', retries: 6 });
    } catch (e) {
      if (e.status === 429 && gap < MAX_GAP_MS) {
        gap = Math.min(gap * 2, MAX_GAP_MS);
        onThrottle?.(gap);
      }
      throw e;
    }
  }

  async function paginate(first) {
    const out = [];
    let url = first;
    while (url) {
      const r = await api(url);
      out.push(...(r.items || []));
      url = r.next;
    }
    return out;
  }

  let meCache = null;
  const me = async () => (meCache ??= await api('/me'));

  // Sem parâmetro market: a documentação atual só aceita código de país ISO
  // 3166-1 alfa-2, e o valor legado "from_token" saiu. Como todas as chamadas
  // daqui usam token de usuário, o país da conta já tem prioridade sozinho.

  // Um 12" com seis variantes da mesma música gera seis vezes a mesma busca.
  // O catálogo não muda no meio da análise, então a resposta é reaproveitada.
  const searchCache = new Map();
  async function search(q, type) {
    const key = `${type}\u0000${q}`;
    if (!searchCache.has(key)) searchCache.set(key, await api('/search', { params: { q, type, limit: 10 } }));
    return searchCache.get(key);
  }

  async function findOrCreatePlaylist(name, description) {
    const user = await me();
    const all = await paginate('/me/playlists?limit=50');
    const hit = all.find((p) => p && p.name === name && p.owner?.id === user.id);
    if (hit) return hit;
    return api('/me/playlists', { method: 'POST', body: { name, public: false, description } });
  }

  // Usa o id guardado da playlist, para que renomeá-la dentro do Spotify não
  // faça o próximo sync criar uma segunda. Só volta a procurar pelo nome se
  // nunca houve id ou se a playlist foi apagada (404).
  // rename=true quer dizer que o nome mudou aqui na página e manda no Spotify.
  async function resolvePlaylist({ id, name, description, rename = false } = {}) {
    if (id) {
      try {
        const pl = await api(`/playlists/${id}`);
        if (rename && name && pl.name !== name) {
          await api(`/playlists/${id}`, { method: 'PUT', body: { name } });
          pl.name = name;
        }
        return pl;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return findOrCreatePlaylist(name, description);
  }

  return {
    api,
    me,
    findOrCreatePlaylist,
    resolvePlaylist,
    async searchAlbums(q) {
      const r = await search(q, 'album');
      return r?.albums?.items?.filter(Boolean) || [];
    },
    async searchTracks(q) {
      const r = await search(q, 'track');
      return r?.tracks?.items?.filter(Boolean) || [];
    },
    albumTracks: (id) => paginate(`/albums/${id}/tracks?limit=50`),
    async playlistUris(id) {
      const items = await paginate(`/playlists/${id}/items?limit=50`);
      return items.map((e) => (e.item || e.track)?.uri).filter(Boolean);
    },
    async addItems(id, uris, onProgress) {
      for (let i = 0; i < uris.length; i += 100) {
        await api(`/playlists/${id}/items`, { method: 'POST', body: { uris: uris.slice(i, i + 100) } });
        onProgress?.(Math.min(i + 100, uris.length), uris.length);
      }
    },
  };
}
