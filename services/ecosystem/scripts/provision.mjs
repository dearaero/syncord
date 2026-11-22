/** Operator-only provisioning; no credentials are written to source files. */
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const configPath=path.join(root,'wrangler.local.jsonc'),config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.name!=='syncord-api'||!/^[a-f0-9]{32}$/.test(config.account_id??'')||config.d1_databases?.length!==1||config.d1_databases[0].database_name!=='syncord-db')throw Error('Unexpected Ecosystem deployment target. Copy wrangler.jsonc to wrangler.local.jsonc, fill in your Cloudflare account ID, and review it before provisioning.');
const wrangler=path.join(path.dirname(realpathSync(path.join(root,'node_modules/wrangler/package.json'))),'bin/wrangler.js');
function run(args,json=false){
 const result=spawnSync(process.execPath,[wrangler,...args],{cwd:root,encoding:'utf8',stdio:json?['ignore','pipe','pipe']:['ignore','inherit','inherit'],env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},timeout:120000});
 if(result.error||result.status!==0){if(json&&result.stderr)process.stderr.write(result.stderr);throw Error('Cloudflare command failed. Connect Cloudflare or run wrangler login, then retry. No credentials should be pasted into chat.');}
 return json?JSON.parse(result.stdout):undefined;
}
try{
 let databases=run(['d1','list','--json'],true),database=databases.find(d=>d.name==='syncord-db');
 if(!database){run(['d1','create','syncord-db','--binding','DB','--update-config=false','--jurisdiction','eu']);databases=run(['d1','list','--json'],true);database=databases.find(d=>d.name==='syncord-db');}
 if(!database||typeof database.uuid!=='string'||!/^[a-f0-9-]{36}$/.test(database.uuid))throw Error('Cloudflare did not confirm a real D1 database ID.');
 config.d1_databases[0].database_id=database.uuid;writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
 console.log('Confirmed syncord-db and saved its real D1 binding. Next: pnpm migrate:remote, then pnpm run deploy. Add DISCORD_CLIENT_SECRET only in Worker secrets.');
}catch(error){console.error(error instanceof Error?error.message:'Provisioning failed');process.exitCode=1;}
