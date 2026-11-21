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

// A rotina do GitHub Actions analisa os discos no servidor e publica o
// resultado em cache/cache.json junto com o site. A página adota o que for
// mais novo que o seu, para você ver o avanço da rotina sem ter de clicar em
// nada. Só o cache de matches: a playlist fixada é de quem publicou o site e
// não vale para quem abre a página com a própria coleção.
async function adotarCachePublicado() {
  let pub;
  try {
    const r = await fetch('cache/cache.json', { cache: 'no-store' });
    if (!r.ok) return 0;
    pub = await r.json();
  } catch {
    return 0;
  }
  let mudou = 0;
  let matches = 0; // só o que é avanço de análise: tracklist do Discogs não conta
  for (const area of ['discogs', 'spotify', 'youtube']) {
    for (const [k, v] of Object.entries(pub?.[area] || {})) {
      const meu = state.cache[area][k];
      const adotar = area === 'discogs' ? !meu : !meu || (v?.checkedAt || 0) > (meu?.checkedAt || 0);
      if (!adotar) continue;
      state.cache[area][k] = v;
      mudou++;
      if (area !== 'discogs') matches++;
    }
  }
  if (mudou) {
    LS.set('vp.cache', state.cache);
    render();
  }
  return matches;
}

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
    // Devolve o botão clicado antes de refreshButtons, que só conhece os
    // quatro de plataforma: "Buscar" e "Medir agora" ficavam desabilitados
    // para sempre depois do primeiro clique, e o diagnóstico só rodava uma
    // vez por carregamento de página.
    btn.disabled = false;
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

// O ritmo fica ajustável na página: assim dá para achar o que o Spotify
// aceita sem precisar de um deploy a cada tentativa.
const SP_GAP = Number(LS.get('vp.spGap', 0)) || 350;

const sp = createSpotify({
  getToken: spGetToken,
  minGap: SP_GAP,
  onThrottle: (gap) => log(`Ritmo reduzido para ${gap} ms entre chamadas — a análise continua, só mais devagar.`),
  onWait: ({ delay, attempt, retries, status }) => {
    if (status !== 429) return;
    log(`O Spotify pediu calma (429): esperando ${Math.round(delay / 1000)}s antes de tentar de novo (tentativa ${attempt} de ${retries}).`);
  },
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

/* ---------- espera depois de um bloqueio de ritmo ---------- */
// Vale só para o 429 de ritmo, cuja janela a documentação descreve como 30
// segundos corridos — aí esperar resolve mesmo. O 429 de cota é outro bicho e
// não entra aqui: ninguém sabe quando a cota volta, então em vez de inventar
// prazo a página oferece um teste de uma chamada só.
// O Spotify não diz por quanto tempo bloqueou: o Retry-After não atravessa o
// CORS. Então a espera é nossa — começa curta e cresce se o bloqueio insistir.
const ESPERAS_MIN = [15, 60, 180, 720];

const esperaAtual = () => LS.get('vp.spCooldown', null);
const limparEspera = () => LS.set('vp.spCooldown', null);
const esperaRestante = () => Math.max(0, (esperaAtual()?.until || 0) - Date.now());
const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function iniciarEspera() {
  const ant = esperaAtual();
  // Bloqueios próximos vão somando; depois de 6 h sem apanhar, recomeça do pé.
  const emSequencia = ant && Date.now() - (ant.at || 0) < 6 * 3600e3;
  const strikes = Math.min((emSequencia ? ant.strikes : 0) + 1, ESPERAS_MIN.length);
  const min = ESPERAS_MIN[strikes - 1];
  const until = Date.now() + min * 60e3;
  LS.set('vp.spCooldown', { until, at: Date.now(), strikes });
  return { until, min };
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function duracao(ms) {
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// "Refazer" é ação de uma vez só: a caixa se desmarca ao começar. Deixada
// ligada, todo clique recomeçava do primeiro disco — e, com a cota curta do
// Spotify, a análise morria sempre no mesmo ponto sem nunca alcançar o resto.
// Tamanho do lote: quantos discos cada clique reanalisa. A cota do Spotify em
// Development Mode não é publicada em lugar nenhum, então o número certo é o
// que a conta aguentar — e quem descobre isso é você, clicando.
const loteAtual = () => Number($('#sp-lote')?.value || 0);

function takeForce() {
  const el = $('#force');
  const on = el.checked;
  el.checked = false;
  return on;
}

async function runMatch(platform) {
  log('');
  setPlatform(platform);

  // Dentro da janela de espera nem se chama a API: insistir durante um
  // bloqueio é o que o prolonga.
  const resta = platform === 'spotify' ? esperaRestante() : 0;
  if (resta) {
    const msg = `Em espera depois de um bloqueio de ritmo do Spotify. Pode tentar de novo às ${hhmm(esperaAtual().until)} — faltam ${duracao(resta)}.`;
    progress(platform, 0, state.albums.length, 'Em espera — nenhuma chamada foi feita.');
    showResult(platform, msg, null, {
      label: 'Tentar mesmo assim',
      onClick: () => {
        limparEspera();
        showResult(platform, 'Espera cancelada. Clique de novo para rodar.');
      },
    });
    return { results: {}, stopped: msg, analyzed: 0 };
  }

  // Notícia desde o primeiro instante: o primeiro disco pode demorar, e um
  // botão girando sem texto parece travado.
  const lote = platform === 'spotify' ? loteAtual() : 0;
  const chamadas0 = sp.stats.calls;
  progress(platform, 0, state.albums.length, `0/${state.albums.length} · começando…`);
  const yt = platform === 'youtube' ? newYouTube() : null;
  const { results, stopped: parada, analyzed, adiados, rateLimited, quota, done } = await matchAll({
    platform,
    albums: state.albums,
    cache: state.cache,
    matchFn: matchFnFor(platform, yt),
    force: takeForce(),
    limit: lote,
    onSave: saveCache,
    onResult: (a, r) => {
      state.session[platform][a.key] = r;
      renderSoon();
    },
    onProgress: (i, n, a) => progress(platform, i, n, `${i}/${n} · ${a.artist} – ${a.title}`),
  });
  saveCache();

  // Bloqueou: abre a janela de espera e diz a hora exata de voltar.
  // Passou inteiro: zera o histórico de bloqueios.
  let stopped = parada;
  let acao = null;
  if (rateLimited) {
    const { until, min } = iniciarEspera();
    stopped = `${stopped} Tente de novo a partir das ${hhmm(until)} — ${min < 60 ? `${min} min` : duracao(min * 60000)} a partir de agora.`;
  } else if (quota) {
    // Cota não tem relógio conhecido: em vez de chutar um prazo, a página
    // oferece o teste mais barato que existe — uma busca só.
    stopped = `${stopped} Isso não é pressa: é o saldo de buscas do app, que o Spotify não publica nem dá prazo de volta. Diminuir o lote faz cada rodada caber no que sobrar.`;
    acao = {
      label: 'Testar se voltou (1 chamada)',
      onClick: async () => {
        showResult(platform, 'Testando…');
        try {
          await sp.ping();
          showResult(platform, 'A busca respondeu 200: a cota voltou. Pode rodar.');
        } catch (e) {
          showResult(platform, `Ainda bloqueado — ${e.message}`, null, acao);
        }
      },
    };
  } else if (platform === 'spotify' && !stopped) {
    limparEspera();
  }
  // Lote cheio não é interrupção: terminou o que foi combinado.
  const loteCheio = adiados && !stopped;
  if (loteCheio) stopped = `${adiados === 1 ? 'Falta' : 'Faltam'} ${plural(adiados, 'disco', 'discos')}. Clique de novo para continuar de onde parou.`;

  // A linha de progresso tem que terminar contando o desfecho. Parada logo no
  // começo, ela ficava presa em "começando…", dizendo o oposto da mensagem de
  // erro logo abaixo.
  const n = state.albums.length;
  const feitos = `${plural(analyzed, 'disco analisado', 'discos analisados')} nesta rodada`;
  progress(
    platform,
    stopped && !loteCheio ? done : n,
    n,
    loteCheio ? `Lote concluído · ${feitos}` : stopped ? `Interrompida · ${feitos}` : `Análise concluída · ${n} discos`,
  );
  const c = countStatuses(platform);
  const gastas = sp.stats.calls - chamadas0;
  const custo = platform === 'spotify' && gastas ? ` · ${gastas} ${gastas === 1 ? 'chamada' : 'chamadas'} ao Spotify` : '';
  const line = `${plural(c.full, 'completo', 'completos')} · ${plural(c.partial, 'parcial', 'parciais')} · ${c.none} sem match${
    c.pending ? ` · ${plural(c.pending, 'pendente', 'pendentes')}` : ''
  }${custo}`;
  showResult(platform, stopped ? `${line}. ${stopped}` : line, null, acao);
  const digest = errorDigest(platform);
  if (digest) log(digest);
  render();
  return { results, stopped, analyzed };
}

async function runSync(platform) {
  log('');
  setPlatform(platform);
  if (platform === 'spotify') {
    const { results, stopped } = await runMatch('spotify');
    // A análise e a escrita usam baldes de cota diferentes: a busca pode estar
    // esgotada e a playlist, viva. Então o que já foi casado em rodadas
    // anteriores vai para a playlist mesmo quando a análise de hoje nem
    // começou — era isso que deixava uma coleção meio resolvida sem nenhuma
    // playlist para ouvir.
    const casadas = Object.values(results).reduce((n, r) => n + (r?.tracks || []).filter((t) => t.match).length, 0);
    if (!casadas) {
      showResult('spotify', `Nada para escrever na playlist ainda. ${stopped || ''}`.trim());
      return;
    }
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
    // "0 faixas novas (524 no total)" lia como fracasso e era o oposto: a
    // playlist já estava inteira. Quando não falta nada, a frase tem que
    // dizer que está em dia, não contar um zero.
    const emDia = r.added === 0 && r.total > 0;
    progress('spotify', 1, 1, emDia ? 'Playlist já estava em dia.' : stopped ? 'Playlist atualizada com o que já estava casado.' : 'Playlist atualizada.');
    const novas = r.added === 1 ? '1 faixa nova' : `${r.added} faixas novas`;
    const msg = emDia
      ? `“${r.playlistName}” já tem as ${r.total} faixas que conseguimos casar até agora — nada a acrescentar.`
      : `${novas} em “${r.playlistName}” (${r.total} no total).`;
    showResult('spotify', `${msg}${stopped ? ` ${stopped}` : ''}`, r.url);
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

function showResult(platform, text, url, action) {
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
  if (action) {
    const b = document.createElement('button');
    b.className = 'linkish';
    b.textContent = action.label;
    b.onclick = action.onClick;
    el.append(b);
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

/* ---------- diagnóstico ---------- */
const carimbo = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function registrarSonda(r) {
  const h = LS.get('vp.spSondas', []);
  h.push({ t: Date.now(), s: r?.status ?? 0, c: /QUOTA_EXCEEDED/i.test(r?.body || '') });
  const corte = h.slice(-30);
  LS.set('vp.spSondas', corte);
  return corte;
}

// Chamada avulsa: sem freio, sem retentativa, só para ler o código cru.
// O navegador não enxerga o cabeçalho Retry-After (o Spotify não o expõe por
// CORS), então o que dá para medir daqui é status, corpo e tempo.
async function probe(path) {
  const token = await spGetToken();
  const t0 = performance.now();
  let r;
  try {
    r = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: String(e.message || e) };
  }
  const ms = Math.round(performance.now() - t0);
  let body = '';
  try {
    body = (await r.text()).slice(0, 300);
  } catch {}
  return { status: r.status, ms, retryAfter: r.headers.get('Retry-After'), body };
}

async function runDiagnostic() {
  const el = $('#diag-out');
  el.hidden = false;
  const linhas = [];
  const say = (s) => {
    linhas.push(s);
    el.textContent = linhas.join('\n');
  };

  say(`versão ${CONFIG.version} · ${new Date().toLocaleTimeString('pt-BR')}`);
  say('');

  // A cota do Development Mode não é um número só: a documentação diz que os
  // endpoints vão para baldes e cada balde tem seu limite. Então a pergunta
  // útil não é "estou bloqueado?", é "o que ainda responde?". Se a busca
  // estiver morta mas álbum e playlist vivos, existe caminho sem busca.
  const pl = playlistPin()?.id;
  const baldes = [
    ['perfil   ', '/me'],
    ['busca    ', '/search?q=caetano&type=album&limit=1'],
    ['álbum    ', '/albums/4aawyAB9vmqN3uQ7FjRGTy/tracks?limit=1'],
    ['playlists', '/me/playlists?limit=1'],
  ];
  if (pl) baldes.push(['faixas pl', `/playlists/${pl}/items?limit=1`]);

  const vivos = [];
  let busca = null;
  for (const [nome, path] of baldes) {
    const r = await probe(path);
    const marca = r.status === 200 ? 'ok' : r.status === 429 ? (/QUOTA_EXCEEDED/i.test(r.body) ? 'COTA' : 'RITMO') : String(r.status);
    say(`${nome} -> ${String(r.status).padEnd(4)} ${marca.padEnd(5)} ${r.ms} ms`);
    if (r.status !== 200) say(`            ${r.body.slice(0, 160)}`);
    if (r.status === 200) vivos.push(nome.trim());
    if (nome.startsWith('busca')) busca = r;
    await new Promise((r2) => setTimeout(r2, 400));
  }

  // A única pergunta em aberto do projeto é quando a cota de busca volta, e a
  // documentação não responde. Guardar cada sondagem transforma cliques
  // avulsos em série temporal: é assim que a resposta aparece sozinha.
  const hist = registrarSonda(busca);
  if (hist.length > 1) {
    say('');
    say('sondagens da busca:');
    for (const h of hist.slice(-8)) say(`  ${carimbo(h.t)}  ${h.s}${h.c ? ' COTA' : ''}`);
    const ultimaOk = [...hist].reverse().find((h) => h.s === 200);
    if (busca?.status !== 200) {
      say(ultimaOk ? `  última vez que respondeu: ${carimbo(ultimaOk.t)} (há ${duracao(Date.now() - ultimaOk.t)})` : '  ainda não respondeu nenhuma vez por aqui');
    } else {
      const bloqueio = [...hist].reverse().find((h) => h.s === 429);
      if (bloqueio) say(`  voltou — estava bloqueada ainda às ${carimbo(bloqueio.t)}`);
    }
  }

  say('');
  if (busca?.status === 429) {
    const cota = /QUOTA_EXCEEDED/i.test(busca.body);
    say(cota ? 'A busca está sem cota (QUOTA_EXCEEDED).' : 'A busca levou limite de ritmo (janela de 30 s).');
    say(vivos.length ? `Ainda respondem: ${vivos.join(', ')}.` : 'Nada respondeu: o app está bloqueado por inteiro.');
    if (cota && vivos.some((v) => v === 'playlists')) {
      say('');
      say('A playlist não depende da busca: "Atualizar playlist" escreve o que');
      say('já está casado. Para os discos ainda não analisados não há atalho —');
      say('descobrir o id fora do Spotify foi medido e o MusicBrainz não cobre');
      say('esta coleção. Meça de novo mais tarde; o histórico acima vai mostrar');
      say('a hora em que a busca voltar.');
    }
    return;
  }
  if (busca?.status !== 200) return;

  // Busca viva: mede em que ritmo ela aguenta. Query única em cada chamada
  // para não colher resposta de cache.
  for (const gap of [350, 1000]) {
    let ok = 0;
    let parou = null;
    const t0 = performance.now();
    for (let i = 0; i < 8; i++) {
      if (i) await new Promise((r) => setTimeout(r, gap));
      const p = await probe(`/search?q=teste${Date.now()}x${i}&type=album&limit=1`);
      if (p.status === 200) ok++;
      else {
        parou = p.status;
        break;
      }
    }
    say(`${gap} ms entre chamadas -> ${ok}/8 ok em ${((performance.now() - t0) / 1000).toFixed(1)}s${parou ? ` (parou em ${parou})` : ''}`);
    if (parou) break;
  }
  say('');
  say('8/8 nas duas linhas = ritmo saudável; o que trava é saldo, não pressa.');
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
$('#sp-gap').value = SP_GAP;
$('#sp-gap').onchange = (e) => {
  const v = Math.min(5000, Math.max(100, Number(e.target.value) || 350));
  e.target.value = v;
  LS.set('vp.spGap', v);
  log(`Ritmo salvo: ${v} ms. Recarregue a página para valer na próxima análise.`);
};
$('#sp-lote').value = String(LS.get('vp.spLote', '25'));
$('#sp-lote').onchange = (e) => LS.set('vp.spLote', e.target.value);
$('#btn-diag').onclick = (e) => busy(e.currentTarget, runDiagnostic);
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
  const novos = await adotarCachePublicado();
  if (novos) log(`A rotina automática adiantou ${novos} ${novos === 1 ? 'disco' : 'discos'} desde a sua última visita.`);
})();
