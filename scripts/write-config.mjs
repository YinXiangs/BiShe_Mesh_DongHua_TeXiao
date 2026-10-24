import { writeFile, mkdir, readFile } from 'node:fs/promises';

const defaults = JSON.parse(await readFile(new URL('../public/shared-config.json', import.meta.url), 'utf8'));
const apiUrl = (process.env.PUBLIC_API_URL || defaults.apiUrl || '').trim();
const parsed = new URL(apiUrl);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
  throw new Error('The shared service must use a public HTTPS origin.');
}
await mkdir('public', { recursive: true });
await writeFile('public/config.json', JSON.stringify({
  apiUrl: parsed.origin,
  githubRepo: process.env.GITHUB_REPOSITORY_NAME || 'YinXiangs/BiShe_Mesh_DongHua_TeXiao'
}, null, 2));