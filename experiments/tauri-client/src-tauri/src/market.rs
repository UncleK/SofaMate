use std::{fs::{self,File,OpenOptions},io::{Read,Write},sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
use reqwest::blocking::{Client,Response,Body};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use crate::{library::{Library,Entry,save_json,progress},video};
pub fn client(lib:&Library)->Result<Client,String>{let mut builder=Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(1800)).user_agent("SofaMate/0.1.0");if lib.port!=0{builder=builder.no_proxy();}builder.build().map_err(|e|e.to_string())}
pub fn base(lib:&Library)->String{if lib.port==0{"https://sofamate.aveniqa.com".into()}else{format!("http://127.0.0.1:{}",lib.port)}}
pub fn response(r:Result<Response,reqwest::Error>)->Result<Value,String>{let r=r.map_err(|_|"无法连接分享市场，请检查网络")?;let ok=r.status().is_success();let mut b=vec![];r.take(2*1024*1024).read_to_end(&mut b).map_err(|e|e.to_string())?;let v:Value=serde_json::from_slice(&b).map_err(|_|"市场返回了无效响应")?;if !ok{return Err(v["error"].as_str().unwrap_or("市场请求失败").into())}Ok(v)}
fn id(value:&str)->Result<&str,String>{if value.len()!=36||!value.bytes().all(|c|c.is_ascii_hexdigit()||c==b'-'){return Err("分享标识无效".into())}Ok(value)}
pub fn session(lib:&Library,name:&str)->Result<Value,String>{
 if lib.port==0{let v=crate::account::saved(lib)?;return Ok(json!({"id":v["user"]["id"],"name":v["user"]["name"],"token":v["token"]}))}
 let path=lib.root.join("market-session.json");if let Ok(b)=fs::read(&path){let v:Value=serde_json::from_slice(&b).map_err(|e|e.to_string())?;return Ok(v)}
 let v=response(client(lib)?.post(format!("{}/v1/sessions",base(lib))).json(&json!({"name":name})).send())?;save_json(&path,&v)?;Ok(v)
}
pub fn list(lib:&Library,query:&str,offset:u64,featured:bool)->Result<Value,String>{let mut request=client(lib)?.get(format!("{}/v1/items",base(lib))).query(&[("q",query.to_string()),("offset",offset.to_string()),("featured",if featured{"1"}else{"0"}.to_string())]);
 if let Ok(s)=crate::account::saved(lib){if let Some(token)=s["token"].as_str(){request=request.bearer_auth(token);}}
 let mut v=response(request.send())?;
 for item in v["items"].as_array_mut().ok_or("目录无效")?{let item_id=id(item["id"].as_str().ok_or("目录无效")?)?.to_string();
  let safe_path=|key:&str,fallback:String|->String{let path=item[key].as_str().unwrap_or(&fallback);if path.starts_with('/')&&!path.starts_with("//")&&!path.contains('\\'){format!("{}{}",base(lib),path)}else{format!("{}{}",base(lib),fallback)}};
  let cover=safe_path("coverPath",format!("/v1/items/{item_id}/cover"));let share=safe_path("sharePath",format!("/wallpaper/{item_id}"));item["coverUrl"]=json!(cover);item["shareUrl"]=json!(share);}
 let p=crate::account::profile(lib);v["owner"]=p["id"].clone();Ok(v)
}
pub fn feature(lib:&Library,item_id:&str,featured:bool)->Result<Value,String>{id(item_id)?;let s=session(lib,"")?;response(client(lib)?.put(format!("{}/v1/curation/{item_id}",base(lib))).bearer_auth(s["token"].as_str().ok_or("身份无效")?).json(&json!({"featured":featured})).send())}
struct UploadReader{file:File,done:u64,total:u64,app:tauri::AppHandle,cancel:Arc<AtomicBool>}
impl Read for UploadReader{fn read(&mut self,b:&mut[u8])->std::io::Result<usize>{if self.cancel.load(Ordering::SeqCst){return Err(std::io::Error::other("操作已取消"))}let n=self.file.read(b)?;self.done+=n as u64;if n>0{progress(&self.app,"正在上传视频",self.done,self.total)}Ok(n)}}
pub fn publish(lib:&Library,app:&tauri::AppHandle,entry_id:&str,title:&str,description:&str,name:&str)->Result<Value,String>{
 let entry=lib.get(entry_id)?;if !entry.ready{return Err("请先生成九宫格预览".into())}let cover=fs::read(lib.path(entry_id,"cover.jpg")?).map_err(|e|e.to_string())?;video::jpeg(&cover)?;
 let s=session(lib,name)?;let token=s["token"].as_str().ok_or("身份无效")?;let c=client(lib)?;
 let draft=response(c.post(format!("{}/v1/items",base(lib))).bearer_auth(token).json(&json!({"title":title,"description":description,"bytes":entry.bytes,"sha256":entry.sha256,"coverVersion":entry.cover_version})).send())?;
 let item=id(draft["id"].as_str().ok_or("分享标识无效")?)?;let url=format!("{}/v1/items/{item}",base(lib));
 let result=(||{
  let file=File::open(lib.path(entry_id,"video.mp4")?).map_err(|e|e.to_string())?;let body=Body::sized(UploadReader{file,done:0,total:entry.bytes,app:app.clone(),cancel:lib.cancel.clone()},entry.bytes);
  response(c.put(format!("{url}/video")).bearer_auth(token).header("Content-Type","video/mp4").body(body).send())?;lib.check_cancel()?;
  progress(app,"正在上传九宫格",0,cover.len()as u64);response(c.put(format!("{url}/cover")).bearer_auth(token).header("Content-Type","image/jpeg").body(cover).send())?;lib.check_cancel()?;
  progress(app,"正在发布",0,1);let mut v=response(c.post(format!("{url}/publish")).bearer_auth(token).send())?;v["shareUrl"]=json!(format!("{}/wallpaper/{item}",base(lib)));Ok(v)
 })();if result.is_err(){let _=c.delete(&url).bearer_auth(token).send();}result
}
pub fn download(lib:&Library,app:&tauri::AppHandle,item_id:&str)->Result<Entry,String>{
 id(item_id)?;let c=client(lib)?;let url=format!("{}/v1/items/{item_id}",base(lib));let item=response(c.get(&url).send())?;
 let total=item["bytes"].as_u64().filter(|n|*n>=32&&*n<=video::MAX_BYTES).ok_or("视频大小无效")?;let expected=item["sha256"].as_str().filter(|v|crate::library::valid_id(v)).ok_or("视频校验值无效")?;
 let temp=lib.temp();let mut out=OpenOptions::new().write(true).create_new(true).open(&temp.0).map_err(|e|e.to_string())?;let mut r=c.get(format!("{url}/video")).send().map_err(|_|"下载失败，请检查网络")?;
 if !r.status().is_success()||r.content_length()!=Some(total){return Err("下载大小不匹配".into())}let(mut done,mut hash,mut b)=(0u64,Sha256::new(),vec![0u8;1024*1024]);
 loop{lib.check_cancel()?;let n=r.read(&mut b).map_err(|e|e.to_string())?;if n==0{break}done+=n as u64;if done>total{return Err("下载超出声明大小".into())}hash.update(&b[..n]);out.write_all(&b[..n]).map_err(|e|e.to_string())?;progress(app,"正在下载",done,total)}out.sync_all().map_err(|e|e.to_string())?;drop(out);
 if done!=total||format!("{:x}",hash.finalize())!=expected{return Err("下载文件校验失败".into())}let title=item["title"].as_str().unwrap_or("社区壁纸").chars().take(80).collect();
 let entry=lib.finish(&temp.0,title,done,expected.to_string(),Some(item_id.into()))?;
 let r=c.get(format!("{url}/cover")).send().map_err(|_|"预览图下载失败，可在本机重新生成")?;if !r.status().is_success(){return Err("预览图下载失败，可在本机重新生成".into())}let mut cover=vec![];r.take(1024*1024+1).read_to_end(&mut cover).map_err(|e|e.to_string())?;lib.check_cancel()?;lib.cover(&entry.id,&cover,item["coverVersion"].as_u64().filter(|v|*v==2).unwrap_or(0)as u32)
}
pub fn withdraw(lib:&Library,item_id:&str)->Result<Value,String>{id(item_id)?;let s=session(lib,"本机创作者")?;response(client(lib)?.delete(format!("{}/v1/items/{item_id}",base(lib))).bearer_auth(s["token"].as_str().ok_or("身份无效")?).send())}
