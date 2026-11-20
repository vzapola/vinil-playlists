export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, body, label) {
    const msg = typeof body === 'object' ? body?.error?.message || body?.message || JSON.stringify(body) : body;
    super(`${label || 'HTTP'} ${status}: ${msg || ''}`.trim());
    this.status = status;
    this.body = body;
  }
  get reason() {
    return this.body?.error?.errors?.[0]?.reason || this.body?.error?.status || '';
  }
}

// fetch com retry para 429 (rate limit) e 5xx.
export async function fetchJson(url, opts = {}, { retries = 4, label = '' } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, await safeBody(res), label);
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(ra ? ra * 1000 + 250 : 1500 * 2 ** attempt);
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
