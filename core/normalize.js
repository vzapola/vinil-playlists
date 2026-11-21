// Normalização de textos e similaridade entre títulos/artistas.
// Usado tanto no navegador quanto no Node.

export function stripAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Discogs: "Jorge Ben (2)" -> "Jorge Ben"; "Caetano*" (ANV) -> "Caetano"
export function cleanDiscogsArtist(name) {
  return String(name ?? '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\*+$/, '')
    .trim();
}

const NOISE_WORDS =
  'remaster|remastered|remasterizad[oa]|remasterizacao|deluxe|edition|edicao|version|versao|mono|stereo|estereo|bonus|anniversary|aniversario|expanded|reissue|reedicao|digital|original mix|radio edit|lp version|album version';

const PAREN_NOISE = new RegExp(`[\\(\\[][^\\)\\]]*(?:${NOISE_WORDS})[^\\)\\]]*[\\)\\]]`, 'g');
const DASH_NOISE = new RegExp(`\\s[-–—]\\s[^-–—]*(?:${NOISE_WORDS})[^-–—]*$`, 'g');

const STOPWORDS = new Set(['the', 'a', 'o', 'os', 'as', 'e', 'and', 'de', 'da', 'do', 'das', 'dos', 'of', 'el', 'la', 'le', 'les']);

// Abreviacoes que as duas pontas escrevem de jeitos diferentes: o Discogs
// imprime a capa ("Dr. Robert"), o Spotify escreve por extenso ("Doctor
// Robert"). Sem isso a similaridade cai para 0,67 e a faixa se perde.
// Expandir dos dois lados mantem a comparacao justa.
const ABBREV = {
  dr: 'doctor', mr: 'mister', mrs: 'missus', st: 'saint', jr: 'junior', sr: 'senior',
  vol: 'volume', pt: 'part', no: 'number', ft: 'featuring', feat: 'featuring', vs: 'versus',
};

// Remove acentos, ruídos de reedição, pontuação e stopwords.
export function norm(s) {
  let t = stripAccents(s).toLowerCase();
  t = t.replace(PAREN_NOISE, ' ').replace(DASH_NOISE, ' ');
  t = t.replace(/&/g, ' and ');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = t.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((w) => !STOPWORDS.has(w)).map((w) => ABBREV[w] || w);
  return (kept.length ? kept : tokens.map((w) => ABBREV[w] || w)).join(' ');
}

function bigrams(s) {
  const c = s.replace(/\s+/g, '');
  const out = new Map();
  for (let i = 0; i < c.length - 1; i++) {
    const b = c.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return { map: out, size: Math.max(c.length - 1, 0) };
}

function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return a.replace(/\s/g, '') === b.replace(/\s/g, '') ? 1 : 0;
  let inter = 0;
  for (const [k, v] of A.map) inter += Math.min(v, B.map.get(k) || 0);
  return (2 * inter) / (A.size + B.size);
}

function digits(s) {
  return (s.match(/\d+/g) || []).sort().join(',');
}

// Título "base": o que sobra antes do primeiro travessão e sem os parênteses
// ou colchetes finais. "Musical - Remixed Original Album" -> "Musical";
// "Good Time (Beasley Metromix)" -> "Good Time".
// Serve para os sufixos de versão que nenhuma lista de palavras dá conta de
// enumerar (nomes de remixador, "12\"", "Percapella", e por aí vai).
export function baseTitle(s) {
  let t = String(s ?? '').split(/\s[-–—]\s/)[0].trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  } while (t && t !== prev);
  return t || String(s ?? '').trim();
}

// Similaridade 0..1 entre dois títulos (álbum ou faixa).
// Números diferentes ("Clube da Esquina" x "Clube da Esquina 2") derrubam o
// score — e essa checagem vale para cada comparação separadamente, senão um
// "12\"" no sufixo derrubaria o pareamento pelo título base.
// O título base vale um pouco menos que o título cheio, para que um encontro
// exato seja sempre preferido quando os dois existem.
export function titleSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const full = dice(na, nb) * (digits(na) === digits(nb) ? 1 : 0.5);

  const ba = norm(baseTitle(a));
  const bb = norm(baseTitle(b));
  if (!ba || !bb || (ba === na && bb === nb)) return full;

  const base = dice(ba, bb) * (digits(ba) === digits(bb) ? 1 : 0.5) * 0.95;
  return Math.max(full, base);
}

// Similaridade entre artistas. Aceita contenção de tokens
// ("Chico Buarque De Hollanda" contém "Chico Buarque").
export function artistSim(a, b) {
  const na = norm(cleanDiscogsArtist(a));
  const nb = norm(cleanDiscogsArtist(b));
  if (!na || !nb) return 0;
  const d = dice(na, nb);
  const ta = na.split(' ');
  const tb = nb.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const contained = short.length >= 2 && short.every((t) => long.includes(t));
  return contained ? Math.max(d, 0.9) : d;
}

export function bestArtistSim(discogsArtists, otherArtists) {
  let best = 0;
  for (const a of discogsArtists) for (const b of otherArtists) best = Math.max(best, artistSim(a, b));
  return best;
}

export function isVarious(name) {
  return /^(various|varios|vários|diversos|v\.?a\.?)$/i.test(cleanDiscogsArtist(name));
}
