# Do vinil pra playlist

Lê a coleção do Discogs e monta uma playlist com todos os discos, álbum inteiro, no Spotify e no YouTube Music.

Duas partes:

- **Página web** (`index.html`): você digita um usuário do Discogs, vê a coleção e o relatório de matches em três grupos (completo, parcial, sem match) e atualiza as playlists com um toque.
- **Rotina diária** (`.github/workflows/sync.yml`): roda uma vez por dia no GitHub Actions e adiciona os discos novos sozinha. Também tem o botão "Run workflow" para rodar na hora.

## Como o match funciona

1. Procura o álbum (código de barras do Discogs, depois artista + título). Ignora acentos, sufixos como "(Remastered 2009)" e o "(2)" que o Discogs põe em artistas homônimos. Números diferentes no título derrubam o match, então "Clube da Esquina" não vira "Clube da Esquina 2".
2. Compara a tracklist do disco com a do álbum encontrado, faixa por faixa.
3. As faixas que faltaram são procuradas sozinhas, do mesmo artista, em qualquer outro álbum (coletânea, reedição, ao vivo).

| Grupo | Significa |
|---|---|
| **100%** | Todas as faixas do disco estão no mesmo álbum da plataforma |
| **Parcial** | Faltou alguma faixa, ou parte delas veio de outro álbum (aparece "em 'Nome do álbum'") |
| **Sem match** | Nada encontrado |

A playlist recebe só as faixas do seu disco, na ordem do vinil, e nunca duplica: cada execução lê a playlist e adiciona apenas o que falta. Nada é removido.

## Passo a passo

### 1. Repositório e GitHub Pages
1. Crie o repositório público `vinil-playlists` e suba estes arquivos.
2. Settings › Pages › Source: *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. A página fica em `https://vzapola.github.io/vinil-playlists/`.

### 2. Spotify
1. Em [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), *Create app*, marque **Web API**.
2. Redirect URIs (as duas):
   - `https://vzapola.github.io/vinil-playlists/`
   - `http://127.0.0.1:8888/callback`
3. Copie o **Client ID** para `config.js` (`spotifyClientId`). Guarde o **Client secret** para o passo 5.
4. Se aparecer erro 403, adicione seu e-mail do Spotify em *Settings › User Management*.

O modo de desenvolvimento exige Premium na conta dona do app e aceita até 5 usuários.

### 3. Google / YouTube
1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto.
2. *APIs e serviços › Biblioteca*: ative **YouTube Data API v3**.
3. *Tela de permissão OAuth*: tipo Externo, preencha o básico e depois clique em **Publicar app**. Se ficar em "Teste", o token da rotina expira a cada 7 dias. O Google vai mostrar um aviso de "app não verificado" no login; é só avançar.
4. *Credenciais › Criar ID do cliente OAuth › Aplicativo da Web*:
   - Origens JavaScript autorizadas: `https://vzapola.github.io`
   - URIs de redirecionamento: `http://127.0.0.1:8888/callback`
5. Copie o **ID do cliente** para `config.js` (`googleClientId`). Guarde a **chave secreta**.

### 4. Tokens da rotina (uma vez, num computador com Node 18+)
Na pasta do projeto:

```bash
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node sync/auth.mjs spotify
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node sync/auth.mjs google
```

Cada comando abre o navegador, você autoriza e o terminal imprime um refresh token.

### 5. Secrets no GitHub
Settings › Secrets and variables › Actions.

**Secrets:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` e, opcional, `DISCOGS_TOKEN` (Discogs › Settings › Developers).

**Variables:** `DISCOGS_USERNAME` (obrigatória). Opcionais: `YT_DAILY_BUDGET` (padrão 9000) e `YT_TRACK_SEARCH` = `true` para procurar no YouTube, faixa a faixa, o que não estiver na playlist do álbum.

### 6. Testar
Actions › *Sync diário do vinil* › **Run workflow**. O resumo com os grupos aparece na página da execução.

## Limites que vale conhecer

- **Cota do YouTube:** 10.000 unidades por dia por projeto, dividida entre a página e a rotina. Buscar um álbum custa 100 e cada faixa inserida custa 50, então a primeira carga de uns 65 discos leva de 4 a 5 dias. A rotina continua de onde parou e a playlist vai ficando completa disco por disco. Depois disso, cada disco novo cabe com folga num dia.
- **Discogs sem token:** cerca de 25 requisições por minuto. A primeira leitura das tracklists leva uns 3 minutos; depois fica salva.
- **Cache público:** `cache/cache.json` (matches e tracklists) fica no repositório público. Não tem nenhum segredo nele.
- O GitHub pausa agendamentos em repositórios sem atividade por 60 dias. Se acontecer, é só reativar em Actions.

## Desenvolvimento
`npm test` roda os testes de matching com APIs simuladas.
