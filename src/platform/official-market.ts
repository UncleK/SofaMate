import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const officialPublisher = { id:'SofaMate_collection', name:'SofaMate_collection', official:true };
export function officialItemId(theme:string) {
  const h=createHash('sha256').update('sofamate-official:'+theme).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
// Server-owned immutable catalog. Public discovery never advertises local-only 4K.
export async function officialWorks(file?:string) {
  if(!file)return [];
  const catalog=JSON.parse(await readFile(file,'utf8'));
  return catalog.themes.map((theme:any)=>{
    if(!/^[a-z0-9-]+$/.test(theme.id)||!/^previews\/[a-z0-9-]+\.(jpg|png)$/.test(theme.preview.path))throw Error('Invalid official catalog');
    const variants=theme.variants.filter((v:any)=>v.availability==='ready'&&v.height<=1080&&v.access==='free').map((v:any)=>({id:v.id,label:v.label,width:v.width,height:v.height,fps:v.fps,bytes:v.bytes}));
    if(!variants.length)return null;
    return {id:officialItemId(theme.id),kind:'scene-pack',themeId:theme.id,owner:officialPublisher.id,author:officialPublisher.name,official:true,
      title:theme.label,description:theme.description,createdAt:'2026-09-22T00:00:00.000Z',bytes:variants[0].bytes,
      info:{width:variants[0].width,height:variants[0].height},variants,coverPath:'/official/'+theme.preview.path,
      previewPath:theme.previewVideoPath??null,downloadPath:null,sharePath:'/collections/SofaMate_collection?theme='+encodeURIComponent(theme.id)};
  }).filter(Boolean);
}
