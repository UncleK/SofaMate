use std::{fs,ptr,sync::Mutex,time::Duration};
use serde_json::{Value,json};
use crate::{library::Library,market};
static PENDING:Mutex<Option<Value>>=Mutex::new(None);
#[repr(C)] struct Blob{len:u32,data:*mut u8}
#[link(name="crypt32")] extern "system"{
 fn CryptProtectData(input:*const Blob,description:*const u16,entropy:*const Blob,reserved:*mut std::ffi::c_void,prompt:*mut std::ffi::c_void,flags:u32,output:*mut Blob)->i32;
 fn CryptUnprotectData(input:*const Blob,description:*mut *mut u16,entropy:*const Blob,reserved:*mut std::ffi::c_void,prompt:*mut std::ffi::c_void,flags:u32,output:*mut Blob)->i32;
}
#[link(name="kernel32")] extern "system"{fn LocalFree(data:*mut std::ffi::c_void)->*mut std::ffi::c_void;}
#[link(name="shell32")] extern "system"{fn ShellExecuteW(hwnd:isize,operation:*const u16,file:*const u16,params:*const u16,directory:*const u16,show:i32)->isize;}
fn crypt(bytes:&[u8],protect:bool)->Result<Vec<u8>,String>{
 let input=Blob{len:bytes.len()as u32,data:bytes.as_ptr()as *mut u8};let mut output=Blob{len:0,data:ptr::null_mut()};
 let ok=unsafe{if protect{CryptProtectData(&input,ptr::null(),ptr::null(),ptr::null_mut(),ptr::null_mut(),1,&mut output)}else{CryptUnprotectData(&input,ptr::null_mut(),ptr::null(),ptr::null_mut(),ptr::null_mut(),1,&mut output)}};
 if ok==0{return Err("无法读取本机登录凭据，请重新登录".into())}
 let data=unsafe{std::slice::from_raw_parts(output.data,output.len as usize).to_vec()};unsafe{LocalFree(output.data as *mut _);};Ok(data)
}
pub fn saved(lib:&Library)->Result<Value,String>{
 let file=lib.root.join("market-account.bin");let encrypted=fs::read(file).map_err(|_|"请先登录后再分享")?;
 serde_json::from_slice(&crypt(&encrypted,false)?).map_err(|_|"登录信息无效，请重新登录".into())
}
fn save(lib:&Library,value:&Value)->Result<(),String>{
 let encrypted=crypt(&serde_json::to_vec(value).map_err(|e|e.to_string())?,true)?;
 let file=lib.root.join("market-account.bin");let temp=lib.root.join("market-account.bin.tmp");fs::write(&temp,encrypted).map_err(|e|e.to_string())?;fs::rename(temp,file).map_err(|e|e.to_string())
}
fn open_browser(url:&str)->Result<(),String>{
 let wide:Vec<u16>=url.encode_utf16().chain(Some(0)).collect();let verb:Vec<u16>="open".encode_utf16().chain(Some(0)).collect();
 if unsafe{ShellExecuteW(0,verb.as_ptr(),wide.as_ptr(),ptr::null(),ptr::null(),1)}<=32{return Err("无法打开浏览器，请检查默认浏览器设置".into())}Ok(())
}
pub fn profile(lib:&Library)->Value{
 if lib.port!=0{return fs::read(lib.root.join("market-session.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).map(|v|json!({"id":v["id"],"name":v["name"]})).unwrap_or(Value::Null)}
 saved(lib).map(|v|v["user"].clone()).unwrap_or(Value::Null)
}
pub fn start(lib:&Library)->Result<Value,String>{
 let value=market::response(market::client(lib)?.post(format!("{}/v1/auth/desktop",market::base(lib))).timeout(Duration::from_secs(30)).header("Content-Type","application/json").body("{}").send())?;
 let id=value["id"].as_str().filter(|v|crate::library::valid_id(v)).ok_or("登录服务响应无效")?;
 let url=format!("{}/login?desktop={id}",market::base(lib));open_browser(&url)?;
 *PENDING.lock().unwrap()=Some(value.clone());Ok(json!({"code":value["code"]}))
}
pub fn poll(lib:&Library)->Result<Value,String>{
 let pending=PENDING.lock().unwrap().clone().ok_or("请重新发起登录")?;
 let v=market::response(market::client(lib)?.post(format!("{}/v1/auth/desktop/poll",market::base(lib))).timeout(Duration::from_secs(30)).header("X-SofaMate-Client","desktop").json(&json!({"id":pending["id"],"secret":pending["secret"]})).send())?;
 if v["pending"]==true{return Ok(json!({"pending":true}))}
 if !v["token"].as_str().map(crate::library::valid_id).unwrap_or(false)||v["user"]["id"].as_str().is_none(){return Err("登录服务响应无效".into())}
 save(lib,&v)?;*PENDING.lock().unwrap()=None;Ok(json!({"user":v["user"]}))
}
pub fn logout(lib:&Library)->Result<Value,String>{
 if let Ok(v)=saved(lib){let _=market::client(lib)?.post(format!("{}/v1/auth/logout",market::base(lib))).timeout(Duration::from_secs(30)).bearer_auth(v["token"].as_str().unwrap_or("")).header("Content-Type","application/json").body("{}").send();}
 let file=lib.root.join("market-account.bin");if file.exists(){fs::remove_file(file).map_err(|e|e.to_string())?;}*PENDING.lock().unwrap()=None;Ok(Value::Null)
}
pub fn manage(lib:&Library)->Result<Value,String>{open_browser(&format!("{}/login",market::base(lib)))?;Ok(Value::Null)}
