// Configurações públicas (Client IDs não são segredo; os secrets ficam no GitHub).
export const CONFIG = {
  // Spotify Developer Dashboard > seu app > Client ID
  spotifyClientId: 'COLE_AQUI_O_CLIENT_ID_DO_SPOTIFY',
  // Google Cloud Console > Credenciais > ID do cliente OAuth (tipo "Aplicativo da Web")
  googleClientId: 'COLE_AQUI.apps.googleusercontent.com',

  playlistName: 'Minha coleção de vinil',
  playlistDescription: 'Todos os discos da minha coleção no Discogs, sincronizados automaticamente.',

  // Usuário que aparece preenchido na página (opcional)
  defaultDiscogsUser: '',

  // Unidades da cota diária do YouTube que a página pode gastar por sessão
  youtubeBudgetBrowser: 9000,
};
