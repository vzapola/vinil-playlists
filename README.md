# Do vinil pra playlist

Lê a sua coleção do Discogs e monta no Spotify uma playlist com todos os discos, álbum inteiro, na ordem do vinil. Quando você acrescenta um disco novo na coleção, a playlist se atualiza sozinha no dia seguinte.

Duas partes:

- **Página web** (`index.html`): você digita um usuário do Discogs, vê a coleção e o relatório de matches em três grupos (completo, parcial, sem match) e atualiza a playlist com um toque.
- **Rotina diária** (`.github/workflows/sync.yml`): roda uma vez por dia no GitHub Actions e adiciona os discos novos sozinha. Também tem o botão "Run workflow" para rodar na hora.

A página fica aberta: qualquer pessoa digita o próprio usuário do Discogs e vê a coleção dela. A parte de conectar no Spotify tem um limite que vale conhecer — veja [Quem consegue conectar o Spotify](#quem-consegue-conectar-o-spotify).

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

### 1. GitHub Pages
1. Settings › Pages › Source: *Deploy from a branch*, branch `main`, pasta `/ (root)`.
2. A página fica em `https://vzapola.github.io/vinil-playlists/`.

### 2. App do Spotify
1. Em [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), *Create app*, marque **Web API**.
2. Redirect URIs (as duas):
   - `https://vzapola.github.io/vinil-playlists/`
   - `http://127.0.0.1:8888/callback`
3. Copie o **Client ID** para `config.js` (`spotifyClientId`). Guarde o **Client secret** para o passo 4.
4. Em *Settings › User Management*, acrescente o e-mail da sua conta do Spotify.

> O app nasce em **Development Mode**, e desde março de 2026 isso exige que o dono do app tenha **Spotify Premium**. Se o Premium cair, o app para de funcionar.

### 3. Token da rotina (uma vez, num computador com Node 18+)
Na pasta do projeto:

No PowerShell (Windows):

```powershell
$env:SPOTIFY_CLIENT_ID="xxx"; $env:SPOTIFY_CLIENT_SECRET="yyy"; node sync/auth.mjs spotify
```

No bash (macOS/Linux):

```bash
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node sync/auth.mjs spotify
```

O comando abre o navegador, você autoriza e o terminal imprime um refresh token. Esse token é um segredo: cadastre direto em Settings › Secrets, sem colar em outro lugar.

### 4. Secrets no GitHub
Settings › Secrets and variables › Actions.

**Secrets:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` e, opcional, `DISCOGS_TOKEN` (Discogs › Settings › Developers).

**Variables:** `DISCOGS_USERNAME` (obrigatória) — o usuário cuja coleção a rotina diária acompanha.

### 5. Testar
Actions › *Sync diário do vinil* › **Run workflow**. O resumo com os grupos aparece na página da execução.

## Quem consegue conectar o Spotify

O Spotify limita apps em Development Mode a **5 contas autorizadas**, que o dono do app precisa cadastrar em *Settings › User Management*. Sair desse modo (Extended Quota) só é concedido a organizações com 250 mil usuários ativos por mês, então não é um caminho para um projeto pessoal.

Por isso a página aceita que cada pessoa use o **próprio app do Spotify**: em *Usar meu próprio app do Spotify*, ela cola o Client ID dela e conecta a conta dela. É um cadastro de dois minutos no dashboard do Spotify, e o Client ID fica salvo só no navegador dela.

Ler a coleção do Discogs não tem nenhum limite desses: funciona para qualquer usuário, sem login.

## Limites que vale conhecer

- **Discogs sem token:** cerca de 25 requisições por minuto. A primeira leitura das tracklists de uma coleção de 150 discos leva uns 6 minutos; depois fica salva. Com token pessoal cai pela metade.
- **Cache público:** `cache/cache.json` (matches e tracklists) fica no repositório público. Não tem nenhum segredo nele.
- O GitHub pausa agendamentos em repositórios sem atividade por 60 dias. Se acontecer, é só reativar em Actions.

## YouTube Music (opcional)

O projeto também sincroniza no YouTube Music, mas vem desligado: com `googleClientId` vazio em `config.js`, o bloco do YouTube não aparece na página. Para ativar:

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto e ative a **YouTube Data API v3**.
2. *Tela de permissão OAuth*: tipo Externo, preencha o básico e clique em **Publicar app**. Se ficar em "Teste", o token da rotina expira a cada 7 dias.
3. *Credenciais › Criar ID do cliente OAuth › Aplicativo da Web*:
   - Origens JavaScript autorizadas: `https://vzapola.github.io`
   - URIs de redirecionamento: `http://127.0.0.1:8888/callback`
4. Cole o **ID do cliente** em `config.js` (`googleClientId`).
5. Para a rotina diária: `node sync/auth.mjs google` e acrescente os secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REFRESH_TOKEN`. Variables opcionais: `YT_DAILY_BUDGET` (padrão 9000) e `YT_TRACK_SEARCH` = `true`.

A cota do YouTube é de 10.000 unidades por dia por projeto, dividida entre a página e a rotina. Buscar um álbum custa 100 e cada faixa inserida custa 50, então a primeira carga de uma coleção grande leva alguns dias. A rotina continua de onde parou e a playlist vai ficando completa disco por disco.

## Desenvolvimento
`npm test` roda os testes de matching com APIs simuladas.
