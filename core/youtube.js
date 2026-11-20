import { fetchJson, HttpError } from './http.js';

const API = 'https://www.googleapis.com/youtube/v3';

// Custo em unidades da cota diária (10.000/dia por projeto do Google Cloud).
export const COST = { search: 100, list: 1, insert: 50 };

export class QuotaExhausted extends Error {
  constructor(msg = 'Cota diária do YouTube esgotada. O restante continua amanhã.') {
    super(msg);
    this.name = 'QuotaExhausted';
  }
}

export function createYouTube({ getToken, budget = 9000, onQuota } = {}) {
  const quota = { used: 0, budget };

  function spend(n) {
    if (quota.used + n > quota.budget) throw new QuotaExhausted();
    quota.used += n;
    onQuota?.({ ...quota });
  }

  async function api(path, { method = 'GET', params, body, cost }) {
    spend(cost);
    const token = await getToken();
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetchJson(u, { method, headers, body: body ? JSON.stringify(body) : undefined }, { label: 'YouTube', retries: 2 });
    } catch (e) {
      if (e instanceof HttpError && e.status === 403 && /quota/i.test(e.reason)) {
        quota.used = quota.budget;
        throw new QuotaExhausted();
      }
      throw e;
    }
  }

  async function listAll(path, params) {
    const out = [];
    let pageToken;
    do {
      const r = await api(path, { params: { ...params, maxResults: 50, pageToken }, cost: COST.list });
      out.push(...(r.items || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  return {
    quota,
    async searchPlaylists(q) {
      const r = await api('/search', { params: { part: 'snippet', type: 'playlist', maxResults: 10, q }, cost: COST.search });
      return (r.items || []).map((it) => ({
        id: it.id.playlistId,
        title: it.snippet.title,
        channel: it.snippet.channelTitle || '',
      }));
    },
    async searchVideos(q) {
      const r = await api('/search', {
        params: { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: 5, q },
        cost: COST.search,
      });
      return (r.items || []).map((it) => ({
        videoId: it.id.videoId,
        title: it.snippet.title,
        channel: it.snippet.channelTitle || '',
      }));
    },
    async playlistVideos(playlistId) {
      const items = await listAll('/playlistItems', { part: 'snippet,contentDetails', playlistId });
      return items
        .map((it) => ({
          videoId: it.contentDetails?.videoId,
          title: it.snippet?.title || '',
          channel: it.snippet?.videoOwnerChannelTitle || '',
        }))
        .filter((v) => v.videoId && !/^(deleted|private) video$/i.test(v.title));
    },
    async findOrCreatePlaylist(name, description) {
      const mine = await listAll('/playlists', { part: 'snippet', mine: 'true' });
      const hit = mine.find((p) => p.snippet?.title === name);
      if (hit) return { id: hit.id, title: hit.snippet.title };
      const created = await api('/playlists', {
        method: 'POST',
        params: { part: 'snippet,status' },
        body: { snippet: { title: name, description }, status: { privacyStatus: 'private' } },
        cost: COST.insert,
      });
      return { id: created.id, title: created.snippet.title };
    },
    async addVideo(playlistId, videoId) {
      return api('/playlistItems', {
        method: 'POST',
        params: { part: 'snippet' },
        body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
        cost: COST.insert,
      });
    },
  };
}
