// Rotina diária: lê a coleção do Discogs e atualiza as playlists.
// Roda no GitHub Actions (ver .github/workflows/sync.yml) ou localmente: npm run sync
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { CONFIG } from '../config.js';
import { createDiscogs } from '../core/discogs.js';
import { createSpotify } from '../core/spotify.js';
import { createYouTube } from '../core/youtube.js';
import { matchAlbumSpotify, matchAlbumYouTube, MATCHER_VERSION } from '../core/matcher.js';
import { initCache, loadTracklists, matchAll, syncSpotify, syncYouTube } from '../core/pipeline.js';

const CACHE_FILE = new URL('../cache/cache.json', import.meta.url);
const env = (k) => process.env[k]?.trim() || '';

function refresher(name, url, params, headers = {}) {
  let tok = null;
  return async () => {
    if (tok && Date.now() < tok.exp) return tok.value;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(params),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${name}: falha ao renovar token (${j.error_description || j.error}). Gere um novo refresh token com sync/auth.mjs.`);
    // Alguns provedores devolvem um refresh token novo e invalidam o antigo.
    // A rotina não tem como reescrever o próprio secret, então avisa alto: do
    // contrário ela morreria em silêncio na execução seguinte.
    if (j.refresh_token && j.refresh_token !== params.refresh_token) {
      out(`> **Atenção:** o ${name} devolveu um refresh token novo. Atualize o secret ${name === 'Spotify' ? 'SPOTIFY' : 'GOOGLE'}_REFRESH_TOKEN, senão a próxima execução falha.\n`);
    }
    tok = { value: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
    return tok.value;
  };
}

const lines = [];
const out = (s = '') => {
  console.log(s);
  lines.push(s);
};

function report(platform, albums, results) {
  const by = { full: [], partial: [], none: [], error: [] };
  for (const a of albums) {
    const r = results[a.key];
    if (r) by[r.status]?.push({ a, r });
  }
  out(`**${platform}:** ${by.full.length} completos · ${by.partial.length} parciais · ${by.none.length} sem match${by.error.length ? ` · ${by.error.length} com erro` : ''}`);
  const item = ({ a, r }) => `- ${a.artist} – ${a.title} (${r.found}/${r.total}${r.otherAlbums ? `, ${r.otherAlbums} em outro álbum` : ''})`;
  if (by.partial.length) out(`\n<details><summary>Parciais</summary>\n\n${by.partial.map(item).join('\n')}\n</details>`);
  if (by.none.length) out(`\n<details><summary>Sem match</summary>\n\n${by.none.map(item).join('\n')}\n</details>`);
  if (by.error.length) out(`\n<details><summary>Erros</summary>\n\n${by.error.map(({ a, r }) => `- ${a.artist} – ${a.title}: ${r.error}`).join('\n')}\n</details>`);
  out();
}

async function main() {
  const username = env('DISCOGS_USERNAME');
  if (!username) throw new Error('Defina DISCOGS_USERNAME.');

  let cache = initCache(null);
  try {
    cache = initCache(JSON.parse(await readFile(CACHE_FILE, 'utf8')));
  } catch {}
  const save = async () => {
    await mkdir(new URL('../cache/', import.meta.url), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache));
  };

  out(`## Sync do vinil · ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`);

  const discogs = createDiscogs({ token: env('DISCOGS_TOKEN'), userAgent: 'VinilPlaylists/1.0 +https://github.com/vzapola' });
  const albums = await discogs.getCollection(username);
  await loadTracklists({ albums, discogs, cache });
  await save();
  out(`Coleção de **${username}**: ${albums.length} discos.\n`);

  // Spotify
  if (env('SPOTIFY_REFRESH_TOKEN')) {
    const basic = Buffer.from(`${env('SPOTIFY_CLIENT_ID')}:${env('SPOTIFY_CLIENT_SECRET')}`).toString('base64');
    const getToken = refresher('Spotify', 'https://accounts.spotify.com/api/token', { grant_type: 'refresh_token', refresh_token: env('SPOTIFY_REFRESH_TOKEN') }, { Authorization: `Basic ${basic}` });
    const sp = createSpotify({ getToken, onThrottle: (gap) => console.log(`Spotify pediu calma (429): ritmo reduzido para ${gap} ms entre chamadas.`) });
    const hora = (t) => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // A cota de busca é por conta de desenvolvedor e o Spotify não publica
    // nem o tamanho nem o prazo de reposição. Quando uma execução anterior
    // guardou um prazo (Retry-After, que só chega fora do navegador), esta
    // respeita e nem tenta: bater na porta fechada é o que renova o castigo.
    const espera = cache.spQuota?.until || 0;
    let results = {};

    if (espera > Date.now()) {
      out(`Busca em espera até ${hora(espera)}, prazo pedido pelo próprio Spotify. Nenhuma busca nesta execução.\n`);
      for (const a of albums) if (cache.spotify[a.key]) results[a.key] = cache.spotify[a.key];
    } else {
      // A primeira passada de um disco custa uma busca só (modo barato):
      // 149 discos por 149 chamadas em vez de 555. Quando todos já tiverem
      // passado, as execuções seguintes gastam mais por disco para resgatar
      // os parciais.
      const r0 = (a) => cache.spotify[a.key];
      const esforco = albums.some((a) => r0(a)?.mv !== MATCHER_VERSION)
        ? 'barato'
        : albums.some((a) => r0(a)?.status !== 'full' && (r0(a)?.esforco || 'completo') === 'barato')
          ? 'completo'
          : 'fundo';
      out(`Passada **${esforco}**${esforco === 'barato' ? ', uma busca por disco.' : esforco === 'fundo' ? ', sem teto de faixas.' : ', resgatando os parciais.'}\n`);

      const r = await matchAll({
        platform: 'spotify',
        albums,
        cache,
        esforco,
        matchFn: (a, t, rel) => matchAlbumSpotify(a, t, sp, { ...rel, esforco }),
        onSave: save,
      });
      results = r.results;

      if (r.quota) {
        // O único número real sobre quando a cota volta. Se o cabeçalho vier,
        // vira o prazo da próxima execução; se não vier, a próxima execução
        // agendada descobre sozinha, ao custo de uma chamada.
        const at = Date.now();
        cache.spQuota = { at, retryAfter: r.retryAfter || null, until: r.retryAfter ? at + r.retryAfter * 1000 : null };
        const prazo = r.retryAfter ? `${r.retryAfter}s, volta ${hora(cache.spQuota.until)}` : 'não veio no cabeçalho';
        out(`> Cota de busca esgotada depois de ${r.analyzed} discos. Retry-After: ${prazo}.\n`);
      } else if (r.rateLimited) {
        out(`> Limite de ritmo depois de ${r.analyzed} discos. Continua na próxima execução.\n`);
      } else {
        cache.spQuota = { at: null, retryAfter: null, until: null, lastOkAt: Date.now() };
        out(`Análise concluída: ${r.analyzed} discos analisados nesta execução.\n`);
      }
      await save();
    }

    // A playlist não depende da busca: são baldes de cota diferentes. Escreve
    // o que já está casado mesmo quando a análise não andou nada hoje.
    const temMatch = Object.values(results).some((x) => x?.tracks?.some((t) => t.match));
    if (temMatch) {
      const s2 = await syncSpotify({
        albums,
        results,
        sp,
        playlistName: CONFIG.playlistName,
        description: CONFIG.playlistDescription,
        // SPOTIFY_PLAYLIST_ID manda: é o jeito de apontar a rotina para a
        // playlist que já existe, sem depender de casar pelo nome.
        pinnedId: env('SPOTIFY_PLAYLIST_ID') || cache.playlist.spotify?.id,
        onPlaylist: (pp) => (cache.playlist.spotify = pp),
      });
      await save();
      out(`Spotify: **${s2.added}** ${s2.added === 1 ? 'faixa nova' : 'faixas novas'} em "${s2.playlistName}" (${s2.total} no total). [Abrir](${s2.url})\n`);
    } else out('Spotify: nada casado ainda para escrever na playlist.\n');
    report('Spotify', albums, results);
  } else out('Spotify: pulado (SPOTIFY_REFRESH_TOKEN não definido).\n');

  // YouTube
  if (env('GOOGLE_REFRESH_TOKEN')) {
    const getToken = refresher('Google', 'https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
    });
    const yt = createYouTube({ getToken, budget: Number(env('YT_DAILY_BUDGET')) || 9000 });
    const trackSearch = env('YT_TRACK_SEARCH') === 'true';
    const r = await syncYouTube({
      albums,
      cache,
      yt,
      matchFn: (a, t) => matchAlbumYouTube(a, t, yt, { trackSearch }),
      playlistName: CONFIG.playlistName,
      description: CONFIG.playlistDescription,
      onSave: save,
    });
    await save();
    out(`YouTube: **${r.added}** vídeos adicionados · cota usada ${r.quota.used}/${r.quota.budget}. [Abrir](${r.url})`);
    if (r.stopped) out(`> Cota do dia esgotada. Continua na próxima execução${r.pending ? ` (${r.pending} faixas já identificadas aguardando)` : ''}.`);
    out();
    report('YouTube', albums, Object.fromEntries(albums.map((a) => [a.key, cache.youtube[a.key]]).filter(([, v]) => v)));
  } else out('YouTube: pulado (GOOGLE_REFRESH_TOKEN não definido).\n');

  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
