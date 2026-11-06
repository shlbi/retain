import { readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const file of ['dist/index.html','dist/styles.css','api/workspace.js','supabase/config.toml']) await access(file);
const migrations = (await readdir('supabase/migrations')).filter(file=>file.endsWith('.sql')).sort();
if (!migrations.length || migrations.some(file=>!/^\d{14}_[a-z0-9_]+\.sql$/.test(file))) throw new Error('Use Supabase CLI migration filenames.');
for (const dir of ['dist','server','api']) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const result=spawnSync(process.execPath,['--check',dir+'/'+file],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);
  }
}
const html=await readFile('dist/index.html','utf8');
if(!html.includes('id="auth-view"')||!html.includes('id="workspace-view" hidden'))throw new Error('Authentication view is missing.');
console.log('Static frontend and server functions are ready.');
