import { fetchJson } from './http.js';

const API = 'https://api.spotify.com/v1';

// Endpoints válidos para apps em Development Mode após as mudanças de 2026:
// POST /me/playlists, GET/POST /playlists/{id}/items, GET /search (limit máx. 10).
export function createSpotify({ getToken }) {
  async function api(path, { method = 'GET', body, params } = {}) {
    const token = await getToken();
    const u = new URL(path.startsWith('http') ? path : API + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    return fetchJson(u, { method, headers, body: body ? JSON.stringify(body) : undefined }, { label: 'Spotify' });
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

  // market=from_token é o jeito documentado de dizer "use o mercado do próprio token".
  // Se a API recusar o valor (400), desligamos o parâmetro e seguimos sem ele.
  let useMarket = true;
  async function tryMarket(run) {
    try {
      return await run(useMarket ? 'from_token' : null);
    } catch (e) {
      if (!useMarket || e.status !== 400) throw e;
      useMarket = false;
      return run(null);
    }
  }

  return {
    api,
    me,
    async searchAlbums(q) {
      const r = await tryMarket((market) => api('/search', { params: { q, type: 'album', limit: 10, market } }));
      return r?.albums?.items?.filter(Boolean) || [];
    },
    async searchTracks(q) {
      const r = await tryMarket((market) => api('/search', { params: { q, type: 'track', limit: 10, market } }));
      return r?.tracks?.items?.filter(Boolean) || [];
    },
    albumTracks: (id) => tryMarket((market) => paginate(`/albums/${id}/tracks?limit=50${market ? `&market=${market}` : ''}`)),
    async findOrCreatePlaylist(name, description) {
      const user = await me();
      const all = await paginate('/me/playlists?limit=50');
      const hit = all.find((p) => p && p.name === name && p.owner?.id === user.id);
      if (hit) return hit;
      return api('/me/playlists', { method: 'POST', body: { name, public: false, description } });
    },
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
