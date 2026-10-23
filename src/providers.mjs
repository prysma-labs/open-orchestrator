import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status} (${new URL(url).hostname})`);
  return response.json();
}
export async function research({ fixture, brief, query, adapter }) {
  if (adapter) {
    const module = await import(pathToFileURL(resolve(adapter)).href);
    return module.search({ brief, query });
  }
  if (fixture) return JSON.parse(await readFile(new URL('../fixtures/research.json', import.meta.url)));
  if (!process.env.X_BEARER_TOKEN) throw new Error('Set X_BEARER_TOKEN, use --research-adapter, or explicitly use --fixture-research');
  const url = new URL('https://api.x.com/2/tweets/search/recent');
  url.search = new URLSearchParams({ query, max_results: '20', 'tweet.fields': 'created_at,public_metrics' });
  const data = await request(url, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  if (data.errors?.length) throw new Error('X returned API errors');
  return { fixture: false, query, fetchedAt: new Date().toISOString(), posts: (data.data ?? []).map(p => ({ ...p, url: `https://x.com/i/web/status/${p.id}` })) };
}
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export async function image({ prompt, text, file, fixture, model = process.env.IMAGE_MODEL || 'gpt-image-1', fetchJson = request }) {
  if (fixture) {
    const lines = text.split('/').map(s => s.trim());
    await writeFile(file + '.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536"><rect width="1024" height="1536" fill="#102acc"/><circle cx="800" cy="700" r="410" fill="#ff8b45"/><path d="M0 1100L800 300L1024 800L200 1500Z" fill="#ffe5c4" opacity=".6"/><g font-family="sans-serif" fill="white"><text x="60" y="80" font-size="24">FIXTURE — SVG PLACEHOLDER — NO AI IMAGE</text>${lines.map((s,i)=>`<text x="60" y="${250+i*95}" font-size="55">${escape(s.slice(0,32))}</text>`).join('')}</g></svg>`);
    return { path: file + '.svg', fixture: true, prompt };
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY or explicitly use --fixture-image');
  const data = await fetchJson('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: `${prompt}\nExact poster copy: ${text}`, n: 1, size: '1024x1536' })
  });
  if (!data.data?.[0]?.b64_json) throw new Error('Image provider returned no base64 image');
  await writeFile(file + '.png', Buffer.from(data.data[0].b64_json, 'base64'));
  return { path: file + '.png', fixture: false, model };
}
