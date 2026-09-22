//! Data-only official scene packs; media are downloaded independently of the executable.
use std::{fs::{self,File,OpenOptions},io::{Read,Write},path::{Path,PathBuf},collections::HashSet};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tauri::{Manager,Emitter};
use crate::{Trial,Preset,Media,library,market,hash};
const MAX_FILE:u64=512*1024*1024;
const MAX_PACK:u64=8*1024*1024*1024;
pub fn relative(s:&str)->Result<&str,String>{
 if s.is_empty()||s.len()>240||s.starts_with('/')||!s.bytes().all(|b|b.is_ascii_alphanumeric()||b"_./-".contains(&b))||s.split('/').any(|p|p.is_empty()||p=="."||p==".."||p.ends_with('.')||matches!(p.split('.').next().unwrap().to_ascii_lowercase().as_str(),"con"|"prn"|"aux"|"nul"|"com1"|"com2"|"com3"|"com4"|"com5"|"com6"|"com7"|"com8"|"com9"|"lpt1"|"lpt2"|"lpt3"|"lpt4"|"lpt5"|"lpt6"|"lpt7"|"lpt8"|"lpt9")){return Err("主题文件路径无效".into())}Ok(s)
}
fn get_id(v:&Value)->Result<&str,String>{let s=v.as_str().ok_or("规格标识无效")?;if s.is_empty()||s.len()>96||!s.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){return Err("规格标识无效".into())}Ok(s)}
fn version(v:&Value)->Result<&str,String>{let s=v.as_str().ok_or("版本无效")?;let parts:Vec<_>=s.split('.').collect();if parts.len()!=3||parts.iter().any(|s|s.is_empty()||!s.bytes().all(|c|c.is_ascii_digit())){return Err("版本无效".into())}Ok(s)}
fn checked_file(base:&Path,rel:&str)->Result<PathBuf,String>{
 let mut p=base.to_path_buf();for part in relative(rel)?.split('/') {p.push(part);if let Ok(m)=fs::symlink_metadata(&p){
  use std::os::windows::fs::MetadataExt;
  if m.file_attributes()&0x400!=0{return Err("主题不允许链接目录".into())}
 }}Ok(p)
}
fn check_catalog(v:&Value)->Result<(),String>{
 if v["schemaVersion"]!="1.0"||v["publisher"]["id"]!="SofaMate_collection"{return Err("官方目录格式无效".into())}
 let themes=v["themes"].as_array().filter(|a|a.len()<=100).ok_or("官方目录无效")?;
 let mut ids=HashSet::new();
 for t in themes {get_id(&t["id"])?;relative(t["preview"]["path"].as_str().ok_or("缺少预览")?)?;
  for spec in t["variants"].as_array().filter(|a|a.len()<=16).ok_or("规格无效")? {
   let id=get_id(&spec["id"])?;if !ids.insert(id){return Err("重复规格".into())}version(&spec["version"])?;
   relative(spec["artifact"]["path"].as_str().ok_or("缺少下载地址")?)?;
   if !library::valid_id(spec["artifact"]["sha256"].as_str().unwrap_or(""))||!spec["artifact"]["bytes"].as_u64().is_some_and(|n|n>0&&n<=4*1024*1024){return Err("下载清单无效".into())}
  }
 }Ok(())
}
fn remote(lib:&library::Library,rel:&str)->String{format!("{}/official/{}",market::base(lib),rel)}
fn public_policy(v:&mut Value){if let Some(themes)=v["themes"].as_array_mut(){for t in themes{if let Some(specs)=t["variants"].as_array_mut(){for s in specs{if s["height"].as_u64().unwrap_or(0)>=2160{s["availability"]=json!("local-only");}}}}}}
fn read_small(state:&Trial,rel:&str,max:u64)->Result<Vec<u8>,String>{
 relative(rel)?;
 let mut bytes=vec![];
 if let Some(base)=&state.official_source {File::open(checked_file(base,rel)?).map_err(|e|e.to_string())?.take(max+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;}
 else {let r=market::client(&state.library)?.get(remote(&state.library,rel)).send().map_err(|e|e.to_string())?;if !r.status().is_success(){return Err(format!("官方目录暂时无法访问 ({})",r.status()))}r.take(max+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;}
 if bytes.len()as u64>max{return Err("目录超过大小限制".into())}Ok(bytes)
}
pub fn initial(lib:&library::Library,source:Option<&Path>)->Value{
 let cached=source.map(|p|p.join("catalog.json")).unwrap_or_else(||lib.root.join("official-catalog.json"));
 let fallback=include_bytes!("../../../../assets/official-catalog.json");
 let mut v:Value=fs::read(cached).ok().and_then(|b|serde_json::from_slice(&b).ok()).filter(|v|check_catalog(v).is_ok()).unwrap_or_else(||serde_json::from_slice(fallback).unwrap());if source.is_none(){public_policy(&mut v);}v
}
pub fn refresh(state:&Trial)->Result<(),String>{let mut v:Value=serde_json::from_slice(&read_small(state,"catalog.json",1024*1024)?).map_err(|e|e.to_string())?;check_catalog(&v)?;if state.official_source.is_none(){public_policy(&mut v);}library::save_json(&state.library.root.join("official-catalog.json"),&v)?;*state.official_catalog.lock().unwrap()=v;Ok(())}
pub fn catalog(state:&Trial)->Value{
 let mut v=state.official_catalog.lock().unwrap().clone();let presets=state.presets.lock().unwrap();
 if let Some(themes)=v["themes"].as_array_mut(){for t in themes {
   let rel=t["preview"]["path"].as_str().unwrap_or("").to_string();
   t["coverUrl"]=json!(if state.official_source.is_some(){format!("http://scene.localhost/official/{rel}")}else{remote(&state.library,&rel)});
   if let Some(specs)=t["variants"].as_array_mut(){for s in specs{s["installed"]=json!(presets.iter().any(|p|p.id==s["id"].as_str().unwrap_or("")&&p.data["manifest"]["packVersion"]==s["version"]));}}
 }}v
}
pub fn register_covers(state:&Trial){if let Some(base)=&state.official_source{let v=state.official_catalog.lock().unwrap();if let Some(themes)=v["themes"].as_array(){for t in themes{if let Some(rel)=t["preview"]["path"].as_str(){if let Ok(p)=checked_file(base,rel){if let Ok(m)=fs::metadata(&p){state.media.lock().unwrap().insert(format!("official/{rel}"),Media{path:p,bytes:m.len(),sha256:String::new()});}}}}}}}
pub fn register(state:&Trial,p:Preset){
 for(name,m)in &p.files{state.media.lock().unwrap().insert(format!("{}/{}",p.id,name),m.clone());}
 let mut all=state.presets.lock().unwrap();all.retain(|old|old.id!=p.id);all.push(p);
}
pub fn restore(state:&Trial){
 let base=state.library.root.join("themes");let v=state.official_catalog.lock().unwrap().clone();
 if let Some(themes)=v["themes"].as_array(){for t in themes{if let Some(specs)=t["variants"].as_array(){for spec in specs{
  let Ok(id)=get_id(&spec["id"])else{continue};let Ok(ver)=version(&spec["version"])else{continue};
  let root=base.join(id).join(ver);
  if let Ok(p)=read_installed(&root,t,spec){register(state,p);}
 }}}}
}
fn verify_descriptor(d:&Value,spec:&Value)->Result<(),String>{
 if d["schemaVersion"]!="1.0"||d["packId"]!=spec["id"]||d["version"]!=spec["version"]||d["data"]["manifest"]["packId"]!=spec["id"]||d["data"]["manifest"]["packVersion"]!=spec["version"]{return Err("主题身份不匹配".into())}
 let canvas=&d["data"]["manifest"]["canvas"];
 if canvas["width"]!=spec["width"]||canvas["height"]!=spec["height"]||canvas["fpsNumerator"].as_f64().unwrap_or(0.)/canvas["fpsDenominator"].as_f64().unwrap_or(0.)!=spec["fps"].as_f64().unwrap_or(-1.){return Err("主题分辨率不匹配".into())}
 let files=d["files"].as_array().filter(|a|!a.is_empty()&&a.len()<=4096).ok_or("文件清单无效")?;let(mut total,mut names)=(0u64,HashSet::new());
 for f in files {let rel=relative(f["path"].as_str().ok_or("文件路径无效")?)?;let size=f["bytes"].as_u64().filter(|n|*n>0&&*n<=MAX_FILE).ok_or("文件过大")?;
  if !["mp4","png","json","wav","ogg"].contains(&rel.rsplit('.').next().unwrap())||!names.insert(rel.to_ascii_lowercase())||!library::valid_id(f["sha256"].as_str().unwrap_or("")){return Err("主题文件无效".into())}total=total.checked_add(size).ok_or("主题过大")?;
 }if total>MAX_PACK||total!=spec["bytes"].as_u64().unwrap_or(0)||!names.contains("manifest.json")||!names.contains("checksums.json"){return Err("主题大小或清单无效".into())}Ok(())
}
fn read_installed(root:&Path,theme:&Value,spec:&Value)->Result<Preset,String>{
 let raw=fs::read(checked_file(root,"download.json")?).map_err(|e|e.to_string())?;
 if raw.len()as u64!=spec["artifact"]["bytes"].as_u64().unwrap_or(0)||format!("{:x}",Sha256::digest(&raw))!=spec["artifact"]["sha256"].as_str().unwrap_or(""){return Err("主题清单校验失败".into())}
 let d:Value=serde_json::from_slice(&raw).map_err(|e|e.to_string())?;verify_descriptor(&d,spec)?;
 let mut files=std::collections::HashMap::new();
 for f in d["files"].as_array().unwrap(){let rel=f["path"].as_str().unwrap();let p=checked_file(&root.join("files"),rel)?;let bytes=f["bytes"].as_u64().unwrap();let expected=f["sha256"].as_str().unwrap();
  if fs::metadata(&p).map(|s|s.len()).ok()!=Some(bytes)||hash(&p)?!=expected{return Err(format!("主题文件校验失败: {rel}"))}
  if rel.ends_with(".mp4"){let info=crate::video::inspect(&p)?;if info.width as u64!=spec["width"].as_u64().unwrap()||info.height as u64!=spec["height"].as_u64().unwrap(){return Err("实际视频分辨率错误".into())}}
  files.insert(rel.to_string(),Media{path:p,bytes,sha256:expected.into()});
 }
 let p=checked_file(root,"cover.jpg")?;let bytes=fs::metadata(&p).map_err(|e|e.to_string())?.len();if hash(&p)?!=theme["preview"]["sha256"].as_str().unwrap_or(""){return Err("预览校验失败".into())}files.insert("preview/collage.jpg".into(),Media{path:p,bytes,sha256:theme["preview"]["sha256"].as_str().unwrap().into()});
 Ok(Preset{id:spec["id"].as_str().unwrap().into(),label:theme["label"].as_str().unwrap_or("").into(),scope:"approved-demo".into(),data:d["data"].clone(),files,presentation:json!({"themeId":theme["id"],"label":theme["label"],"author":theme["author"],"description":theme["description"],"previewPath":"preview/collage.jpg","variantLabel":spec["label"],"variants":theme["variants"]})})
}
pub fn install(app:&tauri::AppHandle,id:&str)->Result<Value,String>{
 let state=app.state::<Trial>();let lib=&state.library;let _operation=lib.begin()?;
 let catalog=state.official_catalog.lock().unwrap().clone();
 let (theme,spec)=catalog["themes"].as_array().ok_or("目录为空")?.iter().find_map(|t|t["variants"].as_array()?.iter().find(|v|v["id"]==id).map(|v|(t,v))).ok_or("官方规格不存在")?;
 if spec["availability"]!="ready"||spec["access"]!="free"{return Err("此规格尚未开放下载".into())}get_id(&spec["id"])?;let ver=version(&spec["version"])?;
 if state.official_source.is_none()&&spec["height"].as_u64().unwrap_or(0)>=2160{return Err("4K 暂不开放公网下载".into())}
 let artifact=spec["artifact"]["path"].as_str().ok_or("缺少下载清单")?;
 let bytes=read_small(&state,artifact,4*1024*1024)?;
 if bytes.len()as u64!=spec["artifact"]["bytes"].as_u64().unwrap_or(0)||format!("{:x}",Sha256::digest(&bytes))!=spec["artifact"]["sha256"].as_str().unwrap_or(""){return Err("下载清单校验失败".into())}
 let d:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;verify_descriptor(&d,spec)?;
 let parent=lib.root.join("themes").join(id);let final_dir=parent.join(ver);fs::create_dir_all(&parent).map_err(|e|e.to_string())?;
 if final_dir.exists(){let p=read_installed(&final_dir,theme,spec)?;register(&state,p);return Ok(json!({"installed":id}))}
 // A resumable private directory: interrupted files use .part; only verified files can be reused.
 let stage=parent.join(format!("pending-{ver}"));fs::create_dir_all(&stage).map_err(|e|e.to_string())?;
 let prefix=artifact.rsplit_once('/').ok_or("下载清单路径无效")?.0;let mut done=0;let total=spec["bytes"].as_u64().unwrap();
 for f in d["files"].as_array().unwrap(){lib.check_cancel()?;let rel=f["path"].as_str().unwrap();let target=checked_file(&stage,&format!("files/{rel}"))?;let count=f["bytes"].as_u64().unwrap();let expected=f["sha256"].as_str().unwrap();
  if target.exists()&&fs::metadata(&target).map(|s|s.len()).ok()==Some(count)&&hash(&target)?==expected{done+=count;continue}
  fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;let partial=target.with_extension("part");
  let mut out=OpenOptions::new().write(true).create(true).truncate(true).open(&partial).map_err(|e|e.to_string())?;
  let remote_rel=format!("{prefix}/files/{rel}");
  let mut source:Box<dyn Read>=if let Some(base)=&state.official_source{Box::new(File::open(checked_file(base,&remote_rel)?).map_err(|e|e.to_string())?)}else{let r=market::client(lib)?.get(remote(lib,&remote_rel)).send().map_err(|e|e.to_string())?;if !r.status().is_success(){return Err(format!("下载失败: {}",r.status()))}Box::new(r)};
  let(mut n,mut h,mut buf)=(0u64,Sha256::new(),vec![0u8;1024*1024]);
  loop{lib.check_cancel()?;let k=source.read(&mut buf).map_err(|e|e.to_string())?;if k==0{break}n+=k as u64;if n>count{return Err("下载大小超出清单".into())}h.update(&buf[..k]);out.write_all(&buf[..k]).map_err(|e|e.to_string())?;library::progress(app,"正在下载主题",done+n,total);}
  out.sync_all().map_err(|e|e.to_string())?;drop(out);if n!=count||format!("{:x}",h.finalize())!=expected{return Err("下载校验失败，请重试".into())}fs::rename(&partial,&target).map_err(|e|e.to_string())?;done+=count;
 }
 let cover=read_small(&state,theme["preview"]["path"].as_str().unwrap(),4*1024*1024)?;
 if format!("{:x}",Sha256::digest(&cover))!=theme["preview"]["sha256"].as_str().unwrap_or(""){return Err("预览校验失败".into())}
 fs::write(stage.join("cover.jpg"),cover).map_err(|e|e.to_string())?;fs::write(stage.join("download.json"),bytes).map_err(|e|e.to_string())?;
 library::progress(app,"正在校验并安装",total,total);read_installed(&stage,theme,spec)?;lib.check_cancel()?;
 fs::rename(&stage,&final_dir).map_err(|e|e.to_string())?;let p=read_installed(&final_dir,theme,spec)?;register(&state,p);
 let _=app.emit_to("controls","library-changed",Value::Null);Ok(json!({"installed":id}))
}
#[cfg(test)]mod tests{use super::*;#[test]fn rejects_paths(){for s in ["../bad","/etc/file","a/../../b","a\\b","C:/bad","a//b","a/con.json","a/%2e"]{assert!(relative(s).is_err(),"{s}")}assert!(relative("media/video/E00.mp4").is_ok());}}
