import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeWallpapers, libraryWallpapers, isActive, type Preset, type LocalVideo } from '../experiments/tauri-client/wallpapers';
import { translations, setLocale, getLocale, t } from '../experiments/tauri-client/i18n';
const preset = (id:string, quality:string):Preset => ({ id,label:id,scope:'approved',baseUrl:`http://scene.localhost/${id}/`,presentation:{themeId:'room',label:'Room',description:'Night',previewPath:'cover.jpg',variantLabel:quality,variants:[]} });
const video:LocalVideo = {id:'abc',title:'Local',bytes:100,ready:true,sha256:'hash',info:{width:1920,height:1080,duration:3},createdAt:1};
test('installed themes and local videos share a library, grouped by theme with all quality IDs',()=>{
  const presets=[preset('room720','720P'),preset('room1080','1080P')];
  assert.equal(themeWallpapers(presets).length,1);
  const library=libraryWallpapers(presets,[video]);
  assert.equal(library.length,2);
  assert.deepEqual(library[0].playbackIds,['room720','room1080']);
  assert.equal(library[0].video,undefined);
  assert.equal(library[1].video?.id,'abc');
  assert.equal(library[1].playbackIds[0],'local:abc');
});
test('active wallpaper follows playback identity, survives pause, clears on stop/loading/error',()=>{
  const [theme,local]=libraryWallpapers([preset('room720','720P')],[video]);
  assert.equal(isActive(theme,{selectionId:'room720',paused:true}),true);
  assert.equal(isActive(local,{selectionId:'room720'}),false);
  assert.equal(isActive(local,{selectionId:'local:abc'}),true);
  for(const state of [{stopped:true},{loading:true},{fault:'failure'}])assert.equal(isActive(local,{selectionId:'local:abc',...state}),false);
});
test('all supported language entries preserve interpolation fields',()=>{
  const placeholders=(s:string)=>s.match(/\{\w+\}/g)?.sort()??[];
  for(const [key,values] of Object.entries(translations))for(const value of values){assert.ok(value.trim(),key);assert.deepEqual(placeholders(value),placeholders(key),key);}
  setLocale('en');assert.equal(t('{n} 条分享',{n:3}),'3 shared wallpapers');
  setLocale('ja');assert.equal(t('设为壁纸'),'壁紙に設定');
  setLocale('invalid');assert.equal(getLocale(),'zh-CN');assert.equal(t('设为壁纸'),'设为壁纸');
});
