// Configurações públicas (Client IDs não são segredo; os secrets ficam no GitHub).
export const CONFIG = {
  // Spotify Developer Dashboard > seu app > Client ID
  spotifyClientId: 'COLE_AQUI_O_CLIENT_ID_DO_SPOTIFY',

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
