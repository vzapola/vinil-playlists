// Gera os refresh tokens que a rotina diária usa. Rode no seu computador, uma vez:
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node sync/auth.mjs spotify
//   GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...  node sync/auth.mjs google
// Abre o navegador para você autorizar e imprime o refresh token no terminal.
import http from 'node:http';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = 8888;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const which = process.argv[2];

const PROVIDERS = {
  spotify: {
    id: process.env.SPOTIFY_CLIENT_ID,
    secret: process.env.SPOTIFY_CLIENT_SECRET,
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scope: 'playlist-read-private playlist-modify-private playlist-modify-public',
    extra: {},
    secretName: 'SPOTIFY_REFRESH_TOKEN',
  },
  google: {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube',
    extra: { access_type: 'offline', prompt: 'consent' },
    secretName: 'GOOGLE_REFRESH_TOKEN',
  },
};

const p = PROVIDERS[which];
if (!p) {
  console.log('Uso: node sync/auth.mjs spotify|google');
  process.exit(1);
}
if (!p.id || !p.secret) {
  console.log(`Defina as variáveis ${which.toUpperCase()}_CLIENT_ID e ${which.toUpperCase()}_CLIENT_SECRET.`);
  process.exit(1);
}

const state = crypto.randomBytes(12).toString('hex');
const url = new URL(p.authUrl);
url.search = new URLSearchParams({ client_id: p.id, response_type: 'code', redirect_uri: REDIRECT, scope: p.scope, state, ...p.extra });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') return res.end();
  if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
    res.end('Falhou: ' + (u.searchParams.get('error') || 'state inválido'));
    return;
  }
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: u.searchParams.get('code'),
      redirect_uri: REDIRECT,
      client_id: p.id,
      client_secret: p.secret,
    }),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    res.end('Não veio refresh token: ' + JSON.stringify(j));
    console.error(j);
  } else {
    res.end('Pronto! Pode fechar esta aba e voltar ao terminal.');
    console.log(`\nCrie o secret ${p.secretName} no GitHub com este valor:\n\n${j.refresh_token}\n`);
  }
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Abrindo o navegador. Se não abrir, acesse:\n${url}\n`);
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`);
});
