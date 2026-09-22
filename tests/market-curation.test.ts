import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createMarket} from '../src/platform/market';

test('official works, curated community works and authority survive restart',async()=>{
  await mkdir('test-results/curation',{recursive:true});
  const root=await mkdtemp(path.resolve('test-results/curation/run-'));
  const curatorIds:string[]=[];const options={officialCatalog:path.resolve('assets/official-catalog.json'),curatorIds};
  let server=await createMarket(root,0,options),base=()=>`http://127.0.0.1:${(server.address() as any).port}`;
  const req=(url:string,method='GET',body?:any,token?:string)=>fetch(base()+url,{method,headers:{...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body)});
  try{
    const initial=await(await req('/v1/items')).json() as any;
    assert.equal(initial.items.length,1);const official=initial.items[0];
    assert.equal(official.owner,'SofaMate_collection');assert.equal(official.kind,'scene-pack');assert.equal(official.featured,true);
    assert.equal(official.variants.length,3);assert(official.variants.every((v:any)=>v.height<=1080));
    assert.equal(initial.canCurate,false);assert.equal((await(await req('/v1/items?featured=1')).json() as any).total,1);
    const a=await(await req('/v1/sessions','POST',{name:'SofaMate_collection'})).json() as any;
    const editor=await(await req('/v1/sessions','POST',{name:'Editor'})).json() as any;curatorIds.push(editor.id);
    const video=await readFile('content/engineering-second/0.1.0/media/video/quiet_read.mp4');
    const sha256=createHash('sha256').update(video).digest('hex');
    const draft=await(await req('/v1/items','POST',{title:'Community test',bytes:video.length,sha256,official:true,featured:true},a.token)).json() as any;
    const feature='/v1/curation/'+draft.id;
    assert.equal((await req(feature,'PUT',{featured:true},editor.token)).status,404);
    assert.equal((await req('/v1/items/'+draft.id+'/video','PUT',video,a.token)).status,200);
    assert.equal((await req('/v1/items/'+draft.id+'/cover','PUT',await readFile('tests/fixtures/platform-preview.jpg'),a.token)).status,200);
    assert.equal((await req('/v1/items/'+draft.id+'/publish','POST',undefined,a.token)).status,200);
    assert.equal((await req(feature,'PUT',{featured:true},a.token)).status,403);
    const all=await(await req('/v1/items')).json() as any;const community=all.items.find((i:any)=>i.id===draft.id);
    assert.equal(community.official,false);assert.equal(community.featured,false);assert.equal(community.owner,a.id);
    assert.equal((await req(feature,'PUT',{featured:true},editor.token)).status,200);
    assert.equal((await(await req('/v1/items?featured=1')).json() as any).total,2);
    assert.equal((await(await req('/v1/items','GET',undefined,editor.token)).json() as any).canCurate,true);
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));server=await createMarket(root,0,options);
    assert.equal((await(await req('/v1/items?featured=1')).json() as any).total,2);
    assert.equal((await req('/v1/curation/'+official.id,'PUT',{featured:false},editor.token)).status,200);
    assert.equal((await(await req('/v1/items?featured=1')).json() as any).total,1);
    assert.equal((await(await req('/v1/items')).json() as any).total,2);
    assert.equal((await req('/v1/items/'+draft.id,'DELETE',undefined,a.token)).status,200);
    assert.equal((await(await req('/v1/items?featured=1')).json() as any).total,0);
    assert.equal((await(await req('/v1/publishers/SofaMate_collection')).json() as any).items.length,1);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
