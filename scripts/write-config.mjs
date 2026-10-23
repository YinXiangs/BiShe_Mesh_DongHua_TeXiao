import { writeFile, mkdir } from 'node:fs/promises';
const supabaseAnonKey = process.env.PUBLIC_SUPABASE_ANON_KEY || '';
if (supabaseAnonKey.startsWith('sb_secret_')) throw new Error('Only a Supabase publishable/anon key may be exposed.');
try { const p = JSON.parse(Buffer.from(supabaseAnonKey.split('.')[1] || '', 'base64url').toString()); if (p.role === 'service_role') throw new Error('A service_role key must never be published.'); } catch(e) { if(e.message.includes('service_role')) throw e; }
await mkdir('public', {recursive:true});
await writeFile('public/config.json', JSON.stringify({supabaseUrl: process.env.PUBLIC_SUPABASE_URL || '',supabaseAnonKey, githubRepo: process.env.GITHUB_REPOSITORY_NAME || 'YinXiangs/BiShe_Mesh_DongHua_TeXiao'}, null, 2));
