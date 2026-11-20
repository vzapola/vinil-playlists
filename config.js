// Configurações públicas (Client IDs não são segredo; os secrets ficam no GitHub).
export const CONFIG = {
  // Aparece no rodapé da página. Serve para conferir, de bate-pronto, se o
  // navegador está rodando a versão publicada ou uma em cache.
  version: '2026-11-20 · 6',

  // Spotify Developer Dashboard > seu app > Client ID
  spotifyClientId: '4325e1af4fcc4035b0e61c4e3d146c67',

  // YouTube Music é opcional e vem desligado. Com este campo vazio, o bloco do
  // YouTube não aparece na página e a biblioteca do Google nem é carregada.
  // Para ativar: projeto no Google Cloud > YouTube Data API v3 > ID do cliente OAuth.
  googleClientId: '',

  playlistName: 'Minha coleção de vinil',
  playlistDescription: 'Todos os discos da minha coleção no Discogs, sincronizados automaticamente.',

  // Usuário que já aparece preenchido na página. Deixe vazio para a página ficar
  // aberta: cada pessoa digita o próprio usuário do Discogs (o navegador lembra).
  defaultDiscogsUser: '',

  // Unidades da cota diária do YouTube que a página pode gastar por sessão
  youtubeBudgetBrowser: 9000,
};
