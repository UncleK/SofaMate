use std::{fs::{self,File,OpenOptions},io::{Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{SystemTime,UNIX_EPOCH}};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tauri::Emitter;
use crate::video::{self,Info};

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry{pub id:String,pub title:String,pub bytes:u64,pub sha256:String,pub info:Info,pub created_at:u64,#[serde(default)]pub ready:bool,#[serde(default)]pub cover_version:u32,#[serde(default)]pub cover_updated_at:u64,#[serde(default)]pub market_id:Option<String>}
pub struct Library{pub root:PathBuf,pub entries:Mutex<Vec<Entry>>,pub cancel:Arc<AtomicBool>,pub busy:AtomicBool,pub port:u16}
pub struct Operation<'a>(&'a Library);
impl Drop for Operation<'_>{fn drop(&mut self){self.0.busy.store(false,Ordering::SeqCst);}}
pub struct Temp(pub PathBuf);
impl Drop for Temp{fn drop(&mut self){let _=fs::remove_file(&self.0);}}
pub fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()as u64}
pub fn valid_id(s:&str)->bool{s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit()&&!c.is_ascii_uppercase())}
pub fn save_json(path:&Path,value:&impl Serialize)->Result<(),String>{let temp=path.with_extension("json.tmp");fs::write(&temp,serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;fs::rename(temp,path).map_err(|e|e.to_string())}
pub fn progress(app:&tauri::AppHandle,stage:&str,done:u64,total:u64){let _=app.emit_to("controls","transfer-progress",json!({"stage":stage,"done":done,"total":total}));}
impl Library{
 pub fn open_folder(&self)->Result<(),String>{
  #[link(name="shell32")]unsafe extern "system"{fn ShellExecuteW(hwnd:isize,operation:*const u16,file:*const u16,params:*const u16,directory:*const u16,show:i32)->isize;}
  use std::os::windows::ffi::OsStrExt;
  let folder:Vec<u16>=self.root.as_os_str().encode_wide().chain(Some(0)).collect();let verb:Vec<u16>="open".encode_utf16().chain(Some(0)).collect();
  if unsafe{ShellExecuteW(0,verb.as_ptr(),folder.as_ptr(),std::ptr::null(),std::ptr::null(),1)}<=32{return Err("无法打开壁纸文件夹".into())}Ok(())
 }
 pub fn open(root:PathBuf,port:u16)->Result<Self,String>{fs::create_dir_all(&root).map_err(|e|e.to_string())?;let mut entries=vec![];
  let root=root.canonicalize().map_err(|e|e.to_string())?;
  for folder in ["videos","themes","transfers"]{fs::create_dir_all(root.join(folder)).map_err(|e|e.to_string())?;}
  // Older versions stored hash directories in the root. Keep them readable;
  // new imports/downloads share videos/<sha256>, with no duplicate media copy.
  for base in [root.join("videos"),root.clone()]{
  for dir in fs::read_dir(&base).map_err(|e|e.to_string())?.flatten(){if !dir.file_type().map_err(|e|e.to_string())?.is_dir(){continue}let id=dir.file_name().to_string_lossy().to_string();if !valid_id(&id){continue}
   if entries.iter().any(|e:&Entry|e.id==id){continue}
   if let Ok(b)=fs::read(dir.path().join("entry.json")){if let Ok(e)=serde_json::from_slice::<Entry>(&b){if e.id==id&&e.sha256==id&&fs::metadata(dir.path().join("video.mp4")).map(|m|m.len()==e.bytes).unwrap_or(false){entries.push(e)}}}}
  }
  Ok(Self{root,entries:Mutex::new(entries),cancel:Arc::new(AtomicBool::new(false)),busy:AtomicBool::new(false),port})}
 pub fn begin(&self)->Result<Operation<'_>,String>{if self.busy.swap(true,Ordering::SeqCst){return Err("正在处理另一个文件，请稍候".into())}self.cancel.store(false,Ordering::SeqCst);Ok(Operation(self))}
 pub fn check_cancel(&self)->Result<(),String>{if self.cancel.load(Ordering::SeqCst){Err("操作已取消".into())}else{Ok(())}}
 pub fn get(&self,id:&str)->Result<Entry,String>{self.entries.lock().unwrap().iter().find(|e|e.id==id).cloned().ok_or("本机壁纸不存在".into())}
 pub fn path(&self,id:&str,name:&str)->Result<PathBuf,String>{if !valid_id(id)||!["video.mp4","cover.jpg","entry.json"].contains(&name){return Err("文件标识无效".into())}let current=self.root.join("videos").join(id);let legacy=self.root.join(id);Ok(if !current.exists()&&legacy.exists(){legacy}else{current}.join(name))}
 pub fn update(&self,e:Entry)->Result<(),String>{save_json(&self.path(&e.id,"entry.json")?,&e)?;let mut all=self.entries.lock().unwrap();if let Some(existing)=all.iter_mut().find(|v|v.id==e.id){*existing=e}else{all.push(e)}Ok(())}
 pub fn temp(&self)->Temp{Temp(self.root.join("transfers").join(format!("transfer-{}.tmp",now())))}
 pub fn finish(&self,temp:&Path,title:String,bytes:u64,digest:String,market_id:Option<String>)->Result<Entry,String>{
  let info=video::inspect(temp)?;self.check_cancel()?;
  if let Ok(mut e)=self.get(&digest){if market_id.is_some(){e.market_id=market_id;self.update(e.clone())?}return Ok(e)}
  let dir=self.root.join("videos").join(&digest);fs::create_dir_all(&dir).map_err(|e|e.to_string())?;let dest=dir.join("video.mp4");
  if dest.exists(){return Err("本机文件目录不完整，请重新启动后重试".into())}fs::rename(temp,&dest).map_err(|e|e.to_string())?;
  let entry=Entry{id:digest.clone(),sha256:digest,title,bytes,info,created_at:now(),ready:false,cover_version:0,cover_updated_at:0,market_id};self.update(entry.clone())?;Ok(entry)
 }
 pub fn import(&self,path:&Path,app:Option<&tauri::AppHandle>)->Result<Entry,String>{
  if !path.extension().map(|s|s.to_string_lossy().eq_ignore_ascii_case("mp4")).unwrap_or(false){return Err("请选择 H.264 编码的 MP4 文件".into())}video::inspect(path)?;
  let mut source=File::open(path).map_err(|e|e.to_string())?;let total=source.metadata().map_err(|e|e.to_string())?.len();let temp=self.temp();let mut out=OpenOptions::new().write(true).create_new(true).open(&temp.0).map_err(|e|e.to_string())?;
  let(mut done,mut h,mut b)=(0u64,Sha256::new(),vec![0u8;1024*1024]);loop{self.check_cancel()?;let n=source.read(&mut b).map_err(|e|e.to_string())?;if n==0{break}done+=n as u64;if done>video::MAX_BYTES{return Err("文件超出 1GB".into())}h.update(&b[..n]);out.write_all(&b[..n]).map_err(|e|e.to_string())?;if let Some(app)=app{progress(app,"正在导入",done,total)}}out.sync_all().map_err(|e|e.to_string())?;drop(out);
  let title=path.file_stem().unwrap_or_default().to_string_lossy().chars().take(80).collect();self.finish(&temp.0,title,done,format!("{:x}",h.finalize()),None)
 }
 pub fn cover(&self,id:&str,bytes:&[u8],version:u32)->Result<Entry,String>{video::jpeg(bytes)?;let mut entry=self.get(id)?;let dest=self.path(id,"cover.jpg")?;let temp=dest.with_extension("jpg.tmp");fs::write(&temp,bytes).map_err(|e|e.to_string())?;fs::rename(temp,dest).map_err(|e|e.to_string())?;entry.ready=true;entry.cover_version=version;entry.cover_updated_at=now();self.update(entry.clone())?;Ok(entry)}
 pub fn payload(&self,e:&Entry)->Value{json!({"kind":"video","id":e.id,"title":e.title,"scope":"local-video","label":e.title,"info":e.info,"url":format!("http://scene.localhost/local/{}/video.mp4",e.id)})}
}
