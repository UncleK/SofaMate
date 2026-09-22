// Operator-only tool. Run locally on the server; never shipped to the client.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
if(!args.includes('--data')||!args.includes('--catalog'))throw Error('Required: --data <market-data> --catalog <official-catalog> [--feature <id> | --unfeature <id>]');
const root=path.resolve(value('--data')),file=path.join(root,'curation.json');
const catalog=JSON.parse(await readFile(value('--catalog'),'utf8'));
let selection={};try{selection=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const enabled=args.includes('--feature');const id=value(enabled?'--feature':'--unfeature');
if(!enabled&&!args.includes('--unfeature')){console.log(JSON.stringify(selection,null,2));process.exit(0);}
if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid work id');
const official=catalog.themes.some(t=>{const h=createHash('sha256').update('sofamate-official:'+t.id).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`===id;});
if(!official){const item=JSON.parse(await readFile(path.join(root,'items',id,'item.json'),'utf8'));if(item.id!==id||item.state!=='published')throw Error('Work is not published');}
selection[id]={featured:enabled,actor:'SofaMate_collection',updatedAt:new Date().toISOString()};
await writeFile(file+'.tmp',JSON.stringify(selection));await rename(file+'.tmp',file);
console.log(JSON.stringify({id,featured:enabled}));
