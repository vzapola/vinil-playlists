export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, body, label) {
    const msg = typeof body === 'object' ? body?.error?.message || body?.message || JSON.stringify(body) : body;
    super(`${label || 'HTTP'} ${status}: ${msg || ''}`.trim());
    this.status = status;
    this.body = body;
  }
  // O YouTube poe o motivo em error.errors[].reason; o Spotify, em error.reason.
  // Ler os dois e o que separa "voce correu demais" de "sua cota acabou".
  get reason() {
    return this.body?.error?.errors?.[0]?.reason || this.body?.error?.reason || '';
  }
  // Cota de app em Development Mode. E um 429, mas de outra natureza: nao e
  // ritmo, e saldo. Esperar segundos nao devolve nada e cada nova tentativa
  // so gasta mais. Documentado em concepts/quota-modes.
  get quotaExceeded() {
    return this.status === 429 && /QUOTA_EXCEEDED/i.test(String(this.reason || this.body?.error?.message || ''));
  }
}

// Teto do recuo exponencial. Sem ele, seis tentativas chegam a 48 s de espera
// numa só chamada, e a página parece travada. Retry-After do servidor é
// respeitado como vier, mesmo se for maior.
const MAX_BACKOFF_MS = 20_000;

// fetch com retry para 429 (rate limit) e 5xx.
// onWait avisa quem chamou que vamos dormir, para dar notícia na tela.
export async function fetchJson(url, opts = {}, { retries = 4, label = '', onWait } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      onWait?.({ delay, attempt: attempt + 1, retries, status: 0, label });
      await sleep(delay);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('Retry-After'));
      const err = new HttpError(res.status, await safeBody(res), label);
      if (ra > 0) err.retryAfter = ra;
      // Cota estourada não se resolve insistindo: devolve na hora, sem gastar
      // as retentativas num saldo que só volta com o tempo.
      if (err.quotaExceeded || attempt >= retries) throw err;
      const delay = ra ? ra * 1000 + 250 : Math.min(1500 * 2 ** attempt, MAX_BACKOFF_MS);
      onWait?.({ delay, attempt: attempt + 1, retries, status: res.status, label });
      await sleep(delay);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, await safeBody(res), label);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

async function safeBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
