import { CONFIG } from './config.js';
import { createDiscogs } from './core/discogs.js';
import { createSpotify } from './core/spotify.js';
import { createYouTube } from './core/youtube.js';
import { matchAlbumSpotify, matchAlbumYouTube } from './core/matcher.js';
import { initCache, loadTracklists, matchAll, syncSpotify, syncYouTube } from './core/pipeline.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- armazenamento local (tolerante a falhas) ---------- */
const LS = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.warn('localStorage', e);
    }
  },
  clear() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('vp.')).forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch {}
  },
};

const state = {
  username: LS.get('vp.username', CONFIG.defaultDiscogsUser || ''),
  albums: LS.get('vp.albums', []),
  cache: initCache(LS.get('vp.cache')),
  session: { spotify: {}, youtube: {} },
  platform: 'spotify',
  filter: 'all',
  query: '',
  spUser: null,
  ytUser: null,
};

let saveTimer;
const saveCache = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => LS.set('vp.cache', state.cache), 400);
};

/* ---------- UI helpers ---------- */
function log(msg) {
  const el = $('#log');
  el.hidden = !msg;
  el.textContent = msg || '';
}
function progress(id, i, n, text) {
  const el = $(`#prog-${id}`);
  el.hidden = false;
  el.querySelector('i').style.width = `${n ? Math.round((i / n) * 100) : 0}%`;
  el.querySelector('.ptext').textContent = text || '';
}
async function busy(btn, fn) {
  btn.classList.add('busy');
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    log(friendlyError(e));
  } finally {
    btn.classList.remove('busy');
    refreshButtons();
  }
}
function friendlyError(e) {
  const m = String(e?.message || e);
  if (/Discogs 404/.test(m)) return 'Usuário do Discogs não encontrado.';
  if (/Discogs 40[13]/.test(m)) return 'A coleção está privada. Deixe-a pública no Discogs ou informe o token pessoal do dono da coleção.';
  if (/Spotify 403/.test(m)) return `O Spotify recusou a operação (403). Confira se sua conta está em "User Management" no app do Spotify Developer.\n${m}`;
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Falha de rede. Confira a conexão e tente de novo.';
  return m;
}
const pacificDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/* ---------- Spotify (Authorization Code + PKCE, sem segredo no navegador) ---------- */
const REDIRECT = location.origin + location.pathname;
const SP_SCOPES = 'playlist-read-private playlist-modify-private playlist-modify-public';
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// O app em Development Mode do Spotify aceita no máximo 5 contas autorizadas pelo dono.
// Quem não estiver nessa lista pode criar o próprio app e colar o Client ID aqui na página.
const configured = (id) => !!id && !id.startsWith('COLE_');
const spClientId = () => (LS.get('vp.spClientId', '') || '').trim() || (configured(CONFIG.spotifyClientId) ? CONFIG.spotifyClientId : '');
const YT_ON = configured(CONFIG.googleClientId);

async function spLogin() {
  if (!spClientId()) return log('Falta o Client ID do Spotify. Abra "Usar meu próprio app do Spotify" e cole o seu, ou preencha spotifyClientId em config.js.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('vp.sp.verifier', verifier);
  const u = new URL('https://accounts.spotify.com/authorize');
  u.search = new URLSearchParams({
    client_id: spClientId(),
    response_type: 'code',
    redirect_uri: REDIRECT,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SP_SCOPES,
    state: 'spotify',
  });
  location.href = u;
}

async function spTokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: spClientId(), ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Spotify: ${j.error_description || j.error}`);
  const prev = LS.get('vp.sp.token', {});
  const t = { access_token: j.access_token, refresh_token: j.refresh_token || prev.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
  LS.set('vp.sp.token', t);
  return t;
}

async function spHandleRedirect() {
  const p = new URLSearchParams(location.search);
  if (p.get('state') !== 'spotify') return;
  history.replaceState(null, '', REDIRECT);
  if (p.get('error')) return log(`Spotify: ${p.get('error')}`);
  await spTokenRequest({
    grant_type: 'authorization_code',
    code: p.get('code'),
    redirect_uri: REDIRECT,
    code_verifier: sessionStorage.getItem('vp.sp.verifier') || '',
  });
}

async function spGetToken() {
  let t = LS.get('vp.sp.token');
  if (!t) throw new Error('Conecte o Spotify primeiro.');
  if (Date.now() > t.expires_at) t = await spTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return t.access_token;
}

const sp = createSpotify({
  getToken: spGetToken,
  onThrottle: (gap) => log(`O Spotify pediu calma (429). Ritmo reduzido para ${gap} ms entre chamadas — a análise continua, só mais devagar.`),
});

/* ---------- YouTube (Google Identity Services, token de 1h) ---------- */
let ytToken = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('vp.yt.token'));
  } catch {
    return null;
  }
})();

function ytLogin() {
  if (!YT_ON) return log('O YouTube Music está desligado. Para ativar, preencha googleClientId em config.js.');
  if (!window.google?.accounts?.oauth2) return log('A biblioteca do Google ainda está carregando. Tente de novo em alguns segundos.');
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.googleClientId,
    scope: 'https://www.googleapis.com/auth/youtube',
    callback: async (resp) => {
      if (resp.error) return log(`Google: ${resp.error}`);
      ytToken = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
      sessionStorage.setItem('vp.yt.token', JSON.stringify(ytToken));
      await refreshPlatformStatus();
    },
  });
  client.requestAccessToken();
}

async function ytGetToken() {
  if (!ytToken || Date.now() > ytToken.expires_at) {
    ytToken = null;
    refreshButtons();
    throw new Error('A sessão do YouTube expirou. Toque em Conectar de novo.');
  }
  return ytToken.access_token;
}

function ytQuotaUsedToday() {
  const q = LS.get('vp.ytQuota');
  return q && q.day === pacificDay() ? q.used : 0;
}
function renderQuota(used) {
  const box = $('#yt-quota');
  box.hidden = false;
  const lim = CONFIG.youtubeBudgetBrowser;
  box.querySelector('i').style.width = `${Math.min(100, (used / lim) * 100)}%`;
  box.querySelector('.qtext').textContent = `Cota de hoje usada nesta página: ${used.toLocaleString('pt-BR')} de ${lim.toLocaleString('pt-BR')} unidades`;
}
function newYouTube() {
  const start = ytQuotaUsedToday();
  return createYouTube({
    getToken: ytGetToken,
    budget: Math.max(0, CONFIG.youtubeBudgetBrowser - start),
    onQuota: (q) => {
      const used = start + q.used;
      LS.set('vp.ytQuota', { day: pacificDay(), used });
      renderQuota(used);
    },
  });
}

/* ---------- status das plataformas ---------- */
async function refreshPlatformStatus() {
  if (LS.get('vp.sp.token')) {
    try {
      state.spUser = await sp.me();
      $('#sp-status').textContent = `conectado · ${state.spUser.display_name || state.spUser.id}`;
      $('#btn-sp-connect').textContent = 'Trocar';
    } catch (e) {
      state.spUser = null;
      $('#sp-status').textContent = 'erro ao conectar';
      log(friendlyError(e));
    }
  }
  if (ytToken && Date.now() < ytToken.expires_at) {
    $('#yt-status').textContent = 'conectado';
    $('#btn-yt-connect').textContent = 'Reconectar';
    renderQuota(ytQuotaUsedToday());
  }
  refreshButtons();
}

function refreshButtons() {
  const has = state.albums.length > 0;
  const spOk = !!state.spUser;
  const ytOk = !!ytToken && Date.now() < ytToken.expires_at;
  $('#btn-sp-match').disabled = !(has && spOk);
  $('#btn-sp-sync').disabled = !(has && spOk);
  $('#btn-yt-match').disabled = !(has && ytOk);
  $('#btn-yt-sync').disabled = !(has && ytOk);
  if (!ytOk && $('#btn-yt-connect').textContent === 'Reconectar') $('#yt-status').textContent = 'sessão expirada';
}

/* ---------- Discogs ---------- */
async function loadCollection() {
  const username = $('#username').value.trim();
  if (!username) return;
  log('');
  const token = $('#discogs-token').value.trim();
  LS.set('vp.discogsToken', token);
  const dg = createDiscogs({ token });

  progress('discogs', 0, 1, 'Lendo a coleção…');
  const albums = await dg.getCollection(username, (p, n) => progress('discogs', p, n, `Coleção: página ${p} de ${n}`));
  if (username !== state.username) state.session = { spotify: {}, youtube: {} };
  state.username = username;
  state.albums = albums;
  LS.set('vp.username', username);
  LS.set('vp.albums', albums);
  render();

  await loadTracklists({
    albums,
    discogs: dg,
    cache: state.cache,
    onSave: saveCache,
    onProgress: (i, n, a) => progress('discogs', i, n, `Tracklists ${i}/${n} · ${a.artist} – ${a.title}`),
  });
  saveCache();
  progress('discogs', 1, 1, 'Coleção carregada.');
  renderSummary();
  render();
}

function renderSummary() {
  const el = $('#collection-summary');
  if (!state.albums.length) return (el.hidden = true);
  const tracks = state.albums.reduce((s, a) => s + (state.cache.discogs[a.releaseId]?.tracklist?.length || 0), 0);
  el.hidden = false;
  el.textContent = `${state.username}: ${state.albums.length} discos · ${tracks} faixas`;
}

/* ---------- playlist ---------- */
// O id da playlist fica guardado depois da primeira criação. É ele que manda,
// não o nome: assim você pode renomear a playlist dentro do Spotify sem que a
// próxima atualização crie uma segunda. Mudar o nome aqui renomeia a de lá.
const playlistName = () => $('#playlist-name').value.trim() || CONFIG.playlistName;
const playlistPin = () => LS.get('vp.spPlaylist', null);

function renderPlaylistHint() {
  const el = $('#playlist-hint');
  const pin = playlistPin();
  if (!pin) return (el.textContent = 'Será criada com este nome na primeira atualização.');
  const name = playlistName();
  el.textContent =
    pin.name === name
      ? `Ligada a “${pin.name}”. Pode renomeá-la dentro do Spotify que a ligação continua.`
      : `Ao atualizar, “${pin.name}” passa a se chamar “${name}”.`;
}

/* ---------- matching e sincronização ---------- */
function matchFnFor(platform, yt) {
  if (platform === 'spotify') return (a, t, rel) => matchAlbumSpotify(a, t, sp, rel);
  const trackSearch = $('#yt-tracksearch').checked;
  return (a, t) => matchAlbumYouTube(a, t, yt, { trackSearch });
}

async function runMatch(platform) {
  log('');
  setPlatform(platform);
  const yt = platform === 'youtube' ? newYouTube() : null;
  const { results, stopped } = await matchAll({
    platform,
    albums: state.albums,
    cache: state.cache,
    matchFn: matchFnFor(platform, yt),
    force: $('#force').checked,
    onSave: saveCache,
    onResult: (a, r) => {
      state.session[platform][a.key] = r;
      renderSoon();
    },
    onProgress: (i, n, a) => progress(platform, i, n, `${i}/${n} · ${a.artist} – ${a.title}`),
  });
  saveCache();
  const c = countStatuses(platform);
  const line = `${c.full} completos · ${c.partial} parciais · ${c.none} sem match${c.pending ? ` · ${c.pending} pendentes` : ''}`;
  showResult(platform, stopped ? `${line}. ${stopped}` : line);
  const digest = errorDigest(platform);
  if (digest) log(digest);
  render();
  return results;
}

async function runSync(platform) {
  log('');
  setPlatform(platform);
  if (platform === 'spotify') {
    const results = await runMatch('spotify');
    progress('spotify', 0, 1, 'Atualizando a playlist…');
    const pin = playlistPin();
    const name = playlistName();
    const r = await syncSpotify({
      albums: state.albums,
      results,
      sp,
      playlistName: name,
      description: CONFIG.playlistDescription,
      pinnedId: pin?.id,
      rename: !!pin && pin.name !== name,
      onPlaylist: (p) => {
        LS.set('vp.spPlaylist', p);
        renderPlaylistHint();
      },
      onProgress: (i, n) => progress('spotify', i, n, `Adicionando ${i}/${n}`),
    });
    progress('spotify', 1, 1, 'Playlist atualizada.');
    showResult('spotify', `${r.added} faixas novas em “${r.playlistName}” (${r.total} no total).`, r.url);
    return;
  }
  const yt = newYouTube();
  const r = await syncYouTube({
    albums: state.albums,
    cache: state.cache,
    yt,
    matchFn: matchFnFor('youtube', yt),
    playlistName: playlistName(),
    description: CONFIG.playlistDescription,
    onSave: saveCache,
    onResult: (a, res) => {
      state.session.youtube[a.key] = res;
      renderSoon();
    },
    onProgress: (i, n, a) => progress('youtube', i, n, `${i}/${n} · ${a.artist} – ${a.title}`),
  });
  saveCache();
  const msg = r.stopped
    ? `${r.added} vídeos adicionados hoje. A cota acabou; rode de novo amanhã (ou deixe a rotina diária continuar).`
    : `${r.added} vídeos novos adicionados. Playlist em dia.`;
  showResult('youtube', msg, r.url);
  render();
}

function showResult(platform, text, url) {
  const el = $(platform === 'spotify' ? '#sp-result' : '#yt-result');
  el.hidden = false;
  el.textContent = text + ' ';
  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Abrir playlist';
    el.append(a);
  }
}

/* ---------- lista de resultados ---------- */
const PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 54"><rect width="54" height="54" fill="#1f1a16"/><circle cx="27" cy="27" r="20" fill="#0c0a09"/><circle cx="27" cy="27" r="7" fill="#e8552d"/><circle cx="27" cy="27" r="1.5" fill="#1f1a16"/></svg>');
const LABEL = { full: '100%', partial: 'parcial', none: 'sem match', pending: '—', error: 'erro' };
const resultOf = (platform, a) => state.session[platform][a.key] || state.cache[platform][a.key] || null;
const statusOf = (platform, a) => resultOf(platform, a)?.status || 'pending';

function countStatuses(platform) {
  const c = { full: 0, partial: 0, none: 0, pending: 0 };
  for (const a of state.albums) {
    const s = statusOf(platform, a);
    c[s === 'error' ? 'none' : s]++;
  }
  return c;
}

// Erro de análise quase sempre é a mesma falha repetida (token, permissão,
// endpoint). Sem isto, 149 discos viram 149 "erro na análise" sem motivo à vista.
function errorDigest(platform) {
  const msgs = new Map();
  for (const a of state.albums) {
    const r = resultOf(platform, a);
    if (r?.status !== 'error') continue;
    msgs.set(r.error, (msgs.get(r.error) || 0) + 1);
  }
  if (!msgs.size) return null;
  const total = [...msgs.values()].reduce((s, n) => s + n, 0);
  const [msg] = [...msgs.entries()].sort((a, b) => b[1] - a[1])[0];
  return `Falhou em ${total} de ${state.albums.length} discos. Erro mais comum: ${msg}`;
}

function setPlatform(p) {
  state.platform = p;
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.platform === p));
  render();
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const sec = $('#results');
  sec.hidden = !state.albums.length;
  if (!state.albums.length) return;
  const p = state.platform;
  const c = countStatuses(p);

  const chips = $('#chips');
  chips.replaceChildren(
    ...[
      ['full', 'completos'],
      ['partial', 'parciais'],
      ['none', 'sem match'],
      ['pending', 'pendentes'],
    ].map(([k, label]) => {
      const b = document.createElement('button');
      b.className = `chip ${k}${state.filter === k ? ' on' : ''}`;
      b.innerHTML = `<b>${c[k]}</b><span>${label}</span>`;
      b.onclick = () => {
        state.filter = state.filter === k ? 'all' : k;
        render();
      };
      return b;
    }),
  );

  const q = state.query.toLowerCase();
  const list = $('#albums');
  const tpl = $('#tpl-album');
  const items = state.albums.filter((a) => {
    const s = statusOf(p, a);
    const sNorm = s === 'error' ? 'none' : s;
    if (state.filter !== 'all' && sNorm !== state.filter) return false;
    return !q || `${a.artist} ${a.title}`.toLowerCase().includes(q);
  });

  list.replaceChildren(
    ...items.map((a) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const r = resultOf(p, a);
      const s = r?.status || 'pending';
      const img = node.querySelector('.thumb');
      img.src = a.thumb || PLACEHOLDER;
      img.onerror = () => (img.src = PLACEHOLDER);
      node.querySelector('.a-title').textContent = a.title;
      node.querySelector('.a-artist').textContent = [a.artist, a.year].filter(Boolean).join(' · ');
      node.querySelector('.a-cov').textContent = r
        ? r.status === 'error'
          ? 'erro na análise'
          : `${r.found}/${r.total} faixas${r.otherAlbums ? ` · ${r.otherAlbums} em outro álbum` : ''}`
        : 'ainda não analisado';
      const badge = node.querySelector('.badge');
      badge.className = `badge ${s}`;
      badge.textContent = LABEL[s];
      const head = node.querySelector('.a-head');
      const body = node.querySelector('.a-body');
      head.onclick = () => {
        if (body.hidden) fillBody(body, a, r);
        body.hidden = !body.hidden;
      };
      return node;
    }),
  );
}

function fillBody(body, album, r) {
  const info = body.querySelector('.a-match');
  info.replaceChildren();
  if (r?.status === 'error') {
    info.textContent = `Erro: ${r.error}`;
  } else if (r?.matchedAlbum) {
    info.append('Álbum encontrado: ');
    const a = document.createElement('a');
    a.href = r.matchedAlbum.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.matchedAlbum.name;
    info.append(a, r.matchedAlbum.artists ? ` (${r.matchedAlbum.artists})` : '');
    if (r.note) info.append(document.createElement('br'), r.note);
  } else if (r) {
    info.textContent = r.found ? 'O álbum não foi encontrado inteiro; as faixas abaixo vieram de outros álbuns.' : 'Nada encontrado nesta plataforma.';
  } else {
    info.textContent = 'Ainda não analisado nesta plataforma.';
  }

  const ol = body.querySelector('.tracks');
  const tracks = r?.tracks?.length ? r.tracks : (state.cache.discogs[album.releaseId]?.tracklist || []).map((t) => ({ ...t, match: undefined }));
  ol.replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement('li');
      const m = t.match;
      li.className = m ? (m.source === 'album' ? 'ok' : 'other') : m === null ? 'miss' : '';
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = m ? (m.source === 'album' ? '✓' : '↪') : m === null ? '✕' : '·';
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = t.position || '';
      const tt = document.createElement('span');
      tt.className = 'tt';
      if (m?.url) {
        const a = document.createElement('a');
        a.href = m.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = t.title;
        tt.append(a);
      } else tt.textContent = t.title;
      if (m?.source === 'other') {
        const sm = document.createElement('small');
        sm.textContent = `em “${m.albumName}”`;
        tt.append(sm);
      }
      li.append(ic, pos, tt);
      return li;
    }),
  );
}

/* ---------- CSV ---------- */
function exportCsv() {
  const p = state.platform;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['artista', 'disco', 'ano', 'status', 'faixas_encontradas', 'faixas_total', 'em_outros_albuns', 'album_encontrado', 'faixas_faltando']];
  for (const a of state.albums) {
    const r = resultOf(p, a);
    rows.push([
      a.artist,
      a.title,
      a.year || '',
      LABEL[r?.status || 'pending'],
      r?.found ?? '',
      r?.total ?? '',
      r?.otherAlbums ?? '',
      r?.matchedAlbum?.name || '',
      (r?.tracks || []).filter((t) => !t.match).map((t) => t.title).join(' | '),
    ]);
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vinil-${p}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- eventos ---------- */
$('#username').value = state.username;
$('#discogs-token').value = LS.get('vp.discogsToken', '');
$('#sp-clientid').value = LS.get('vp.spClientId', '');
$('#sp-clientid').oninput = (e) => {
  LS.set('vp.spClientId', e.target.value.trim());
  log('');
};
$('#playlist-name').value = LS.get('vp.playlistName', '') || CONFIG.playlistName;
$('#playlist-name').oninput = (e) => {
  LS.set('vp.playlistName', e.target.value.trim());
  renderPlaylistHint();
};
$('#form-discogs').onsubmit = (e) => {
  e.preventDefault();
  busy($('#btn-load'), loadCollection);
};
$('#btn-sp-connect').onclick = () => spLogin();
$('#btn-yt-connect').onclick = () => ytLogin();
$('#btn-sp-match').onclick = (e) => busy(e.currentTarget, () => runMatch('spotify'));
$('#btn-sp-sync').onclick = (e) => busy(e.currentTarget, () => runSync('spotify'));
$('#btn-yt-match').onclick = (e) => busy(e.currentTarget, () => runMatch('youtube'));
$('#btn-yt-sync').onclick = (e) => busy(e.currentTarget, () => runSync('youtube'));
$$('.seg button').forEach((b) => (b.onclick = () => setPlatform(b.dataset.platform)));
$('#search').oninput = (e) => {
  state.query = e.target.value;
  render();
};
$('#btn-csv').onclick = exportCsv;
$('#btn-reset').onclick = () => {
  if (!confirm('Apagar coleção, matches e logins salvos neste navegador?')) return;
  LS.clear();
  location.reload();
};

/* ---------- plataformas ativas ---------- */
// O bloco do YouTube só aparece se config.js tiver um googleClientId.
// Sem ele a página fica só com o Spotify, e a biblioteca do Google nem é carregada.
function setupPlatforms() {
  $('.sub').textContent = `Sua coleção do Discogs, faixa por faixa, no Spotify${YT_ON ? ' e no YouTube Music' : ''}.`;
  $('#build').textContent = `versão ${CONFIG.version}`;
  $$('.redirect-uri').forEach((el) => (el.textContent = REDIRECT));
  if (YT_ON) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    document.head.append(s);
    return;
  }
  $('.platform[data-p="youtube"]').hidden = true;
  $('.seg').hidden = true;
  state.platform = 'spotify';
}

/* ---------- início ---------- */
(async () => {
  setupPlatforms();
  renderPlaylistHint();
  try {
    await spHandleRedirect();
  } catch (e) {
    log(friendlyError(e));
  }
  renderSummary();
  render();
  await refreshPlatformStatus();
})();
