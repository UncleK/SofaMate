use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[repr(C)]
struct DisplayDevice { size:u32, name:[u16;32], description:[u16;128], flags:u32, id:[u16;128], key:[u16;128] }
#[link(name="user32")]
unsafe extern "system" { fn EnumDisplayDevicesW(device:*const u16,index:u32,info:*mut DisplayDevice,flags:u32)->i32; }
fn string(s:&[u16])->String { String::from_utf16_lossy(&s[..s.iter().position(|c|*c==0).unwrap_or(s.len())]) }
fn identity(name:&str)->(String,String) {
    let wide:Vec<u16>=name.encode_utf16().chain(Some(0)).collect();
    let mut info:DisplayDevice=unsafe{std::mem::zeroed()};info.size=std::mem::size_of::<DisplayDevice>() as u32;
    if unsafe{EnumDisplayDevicesW(wide.as_ptr(),0,&mut info,1)}!=0 {let id=string(&info.id);if !id.is_empty(){return(id,string(&info.description))}}
    (name.into(),name.into())
}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Display { pub id:String,pub name:String,pub label:String,pub primary:bool,pub x:i32,pub y:i32,pub width:u32,pub height:u32,pub scale:f64 }
impl Display { pub fn window(&self)->String{format!("wallpaper-{}",self.id)} }
pub fn list(app:&tauri::AppHandle)->Result<Vec<Display>,String>{
    let primary=app.primary_monitor().map_err(|e|e.to_string())?.and_then(|m|m.name().cloned());let mut result=Vec::new();
    for monitor in app.available_monitors().map_err(|e|e.to_string())? {
        let name=monitor.name().cloned().ok_or("Unnamed display")?;let(key,label)=identity(&name);let id=format!("{:x}",Sha256::digest(key.as_bytes()))[..16].to_string();
        let p=monitor.position();let s=monitor.size();result.push(Display{id,name:name.clone(),label,primary:primary.as_ref()==Some(&name),x:p.x,y:p.y,width:s.width,height:s.height,scale:monitor.scale_factor()});
    }result.sort_by_key(|d|(!d.primary,d.x,d.y));Ok(result)
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Screen {
    pub selected:String,pub enabled:bool,pub fit:String,
    #[serde(skip)]pub volume:f64,#[serde(skip)]pub generation:u64,#[serde(skip)]pub metrics:serde_json::Value,
}
#[derive(Default,Serialize,Deserialize)]
pub struct Config { pub target:String,pub screens:BTreeMap<String,Screen> }
impl Screen { pub fn new(selected:String,enabled:bool,fit:String)->Self{Self{selected,enabled,fit,volume:0.,generation:0,metrics:serde_json::json!({"stopped":true,"paused":true,"frames":0})}} }
