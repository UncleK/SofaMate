#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{collections::HashMap, fs::{self, File}, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool}}};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, State, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton}};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
mod desktop;
mod displays;
mod video;
mod picker;
mod library;
mod market;
mod account;
mod runtime;
mod official;
// Windows sharing one WebView2 data folder must use matching environment options.
const WEBVIEW_ARGS:&str="--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

#[derive(Clone, Deserialize)]
struct Media { path: PathBuf, sha256: String, bytes: u64 }
#[derive(Clone, Deserialize)]
struct Preset { id: String, label: String, scope: String, data: Value, files: HashMap<String, Media>, #[serde(default)] presentation:Value }
struct Trial { displays:Mutex<displays::Config>, enabled:AtomicBool, transition:Mutex<()>, language:Mutex<String>, tray_items:Mutex<Vec<(String,MenuItem<tauri::Wry>)>>, desktop_mode:bool, presets: Mutex<Vec<Preset>>, official_catalog:Mutex<Value>, official_source:Option<PathBuf>, selected: Mutex<String>, report: Option<PathBuf>, library:Arc<library::Library>, media:Arc<Mutex<HashMap<String,Media>>> }
fn register_entry(state:&Trial,e:&library::Entry) {
 let mut media=state.media.lock().unwrap();
 for name in ["video.mp4","cover.jpg"] {if let Ok(path)=state.library.path(&e.id,name){if let Ok(m)=fs::metadata(&path){media.insert(format!("local/{}/{name}",e.id),Media{path,bytes:m.len(),sha256:String::new()});}}}
}
fn current_payload(state:&Trial,id:&str)->Result<Value,String>{
 if let Some(id)=id.strip_prefix("local:"){let e=state.library.get(id)?;if !e.ready{return Err("请先生成九宫格预览".into())}return Ok(state.library.payload(&e))}
 if id.is_empty(){return Ok(json!({"kind":"empty"}))}
 Ok(payload(state.presets.lock().unwrap().iter().find(|p|p.id==id).ok_or("请先下载这个规格的主题")?))
}
fn hash(path: &Path) -> Result<String, String> {
    let mut f=File::open(path).map_err(|e|e.to_string())?; let mut h=Sha256::new(); let mut b=[0u8;65536];
    loop {let n=f.read(&mut b).map_err(|e|e.to_string())?; if n==0 {break}; h.update(&b[..n]);} Ok(format!("{:x}",h.finalize()))
}
fn payload(p: &Preset) -> Value { json!({"data":p.data,"baseUrl":format!("http://scene.localhost/{}/",p.id),"scope":p.scope,"label":p.label}) }
fn open_controls(app:&tauri::AppHandle)->tauri::Result<()> {
    if let Some(w)=app.get_webview_window("controls") { w.show()?;w.set_focus()?;return Ok(()) }
    let w=WebviewWindowBuilder::new(app,"controls",WebviewUrl::App("index.html".into()))
        .additional_browser_args(WEBVIEW_ARGS)
        .title("SofaMate").inner_size(1280.,800.).min_inner_size(900.,620.).build()?;
    w.set_icon(tauri::image::Image::from_bytes(include_bytes!("../../../../assets/brand/native/screenmate-128.png"))?)?;Ok(())
}
#[tauri::command]
async fn call(app:tauri::AppHandle, window:tauri::WebviewWindow, state:State<'_,Trial>, action:String, value:Option<Value>)->Result<Value,String>{
    let window_monitor=runtime::window_id(&state,window.label());
    if window.label()!="controls" && window_monitor.is_none(){return Err("Unknown window".into())}
    if window_monitor.is_some() && !["current","playback-state","metrics"].contains(&action.as_str()){return Err("Controls only".into())}
    let arg=value.unwrap_or(Value::Null);
    if action=="official-catalog" {return Ok(official::catalog(&state))}
    if action=="official-refresh"||action=="official-install" {let handle=app.clone();return tauri::async_runtime::spawn_blocking(move||{if action=="official-install"{official::install(&handle,arg.as_str().ok_or("规格无效")?)}else{let s=handle.state::<Trial>();official::refresh(&s)?;official::register_covers(&s);Ok(official::catalog(&s))}}).await.map_err(|e|e.to_string())?}
    if action=="preferences" {return Ok(json!({"language":*state.language.lock().unwrap(),"fit":runtime::fit(&state)}))}
    if action=="displays"{return runtime::snapshot(&app)}
    if action=="display-select"{return runtime::set_target(&app,arg.as_str().ok_or("Invalid display")?)}
    if action=="set-fit"{let id=runtime::resolve(&app,&arg)?;runtime::set_fit(&app,&id,arg.as_str().or(arg["fit"].as_str()).ok_or("Invalid fit")?)?;return Ok(Value::Null)}
    if action=="library-folder"{state.library.open_folder()?;return Ok(Value::Null)}
    if action=="set-language" {let lang=arg.as_str().filter(|s|["zh-CN","en","ja"].contains(s)).ok_or("Invalid language")?;library::save_json(&state.library.root.join("preferences.json"),&json!({"language":lang}))?;*state.language.lock().unwrap()=lang.into();for(id,item)in state.tray_items.lock().unwrap().iter(){item.set_text(runtime::tray_text(id,lang)).map_err(|e|e.to_string())?;}return Ok(Value::Null)}
    if action=="library-list" {let entries=state.library.entries.lock().unwrap().clone();for e in &entries{register_entry(&state,e);}return Ok(json!(entries))}
    if action=="market-profile" {return Ok(account::profile(&state.library))}
    if action=="market-info" {return Ok(json!({"public":state.library.port==0}))}
    if ["account-start","account-poll","account-logout","account-manage"].contains(&action.as_str()) {let lib=state.library.clone();return tauri::async_runtime::spawn_blocking(move||match action.as_str(){"account-start"=>account::start(&lib),"account-poll"=>account::poll(&lib),"account-logout"=>account::logout(&lib),_=>account::manage(&lib)}).await.map_err(|e|e.to_string())?}
    if action=="transfer-cancel" {state.library.cancel.store(true,std::sync::atomic::Ordering::SeqCst);return Ok(Value::Null)}
    if action=="market-list" {let lib=state.library.clone();return tauri::async_runtime::spawn_blocking(move||market::list(&lib,arg["query"].as_str().unwrap_or(""),arg["offset"].as_u64().unwrap_or(0),arg["featured"].as_bool().unwrap_or(false))).await.map_err(|e|e.to_string())?}
    if ["import","save-cover","market-publish","market-download","market-withdraw","market-feature"].contains(&action.as_str()) {
        let language=state.language.lock().unwrap().clone();let app2=app.clone();let lib=state.library.clone();let owner=window.hwnd().map_err(|e|e.to_string())?.0 as isize;
        return tauri::async_runtime::spawn_blocking(move||{
            let _operation=lib.begin()?;
            let result=match action.as_str(){
                "import"=>{if let Some(path)=picker::video(owner,&language)? {let e=lib.import(&path,Some(&app2))?;register_entry(&app2.state::<Trial>(),&e);Ok(json!(e))}else{Ok(Value::Null)}},
                "save-cover"=>{let id=arg["id"].as_str().ok_or("壁纸标识无效")?;let bytes:Vec<u8>=serde_json::from_value(arg["bytes"].clone()).map_err(|_|"预览图无效")?;let e=lib.cover(id,&bytes,2)?;register_entry(&app2.state::<Trial>(),&e);Ok(json!(e))},
                "market-feature"=>market::feature(&lib,arg["id"].as_str().ok_or("分享标识无效")?,arg["featured"].as_bool().ok_or("精选状态无效")?),
                "market-publish"=>market::publish(&lib,&app2,arg["id"].as_str().ok_or("壁纸不存在")?,arg["title"].as_str().ok_or("请填写标题")?,arg["description"].as_str().unwrap_or(""),arg["name"].as_str().unwrap_or("本机创作者")),
                "market-download"=>{let e=market::download(&lib,&app2,arg.as_str().ok_or("分享标识无效")?)?;register_entry(&app2.state::<Trial>(),&e);Ok(json!(e))},
                "market-withdraw"=>market::withdraw(&lib,arg.as_str().ok_or("分享标识无效")?),
                _=>unreachable!()
            };
            let _=app2.emit_to("controls","library-changed",Value::Null);result
        }).await.map_err(|e|e.to_string())?;
    }
    match action.as_str(){
        "catalog"=>Ok(json!({"presets":state.presets.lock().unwrap().iter().map(|p|json!({"id":p.id,"label":p.label,"scope":p.scope,"presentation":p.presentation,"baseUrl":format!("http://scene.localhost/{}/",p.id)})).collect::<Vec<_>>(),"selected":runtime::selected(&state,&runtime::target(&state))})),
        "current"=>{let id=window_monitor.clone().unwrap_or_else(||runtime::target(&state));runtime::payload(&state,&id)},
        "preview-payload"=>current_payload(&state,arg.as_str().ok_or("Invalid selection")?),
        "select"=>{let monitor=runtime::resolve(&app,&arg)?;runtime::start(&app,&monitor,arg.as_str().or(arg["id"].as_str()).ok_or("Invalid selection")?)?;Ok(Value::Null)},
        "metrics"=>{let id=window_monitor.clone().map(Ok).unwrap_or_else(||runtime::resolve(&app,&arg))?;Ok(runtime::metrics(&app,&id))},
        "controls"=>{open_controls(&app).map_err(|e|e.to_string())?;Ok(Value::Null)},
        "panel-close"=>{if window.label()!="controls"{return Err("Controls only".into())}window.close().map_err(|e|e.to_string())?;Ok(Value::Null)},
        "playback-state"=>{let id=window_monitor.ok_or("Player only")?;runtime::accept_metrics(&app,&id,arg);Ok(Value::Null)},
        "attach"=>{let id=runtime::resolve(&app,&arg)?;let monitor=displays::list(&app)?.into_iter().find(|d|d.id==id).ok_or("No display")?;let w=app.get_webview_window(&monitor.window()).ok_or("No player window")?;desktop::attach(&app,&w,&monitor)?;Ok(Value::Null)},
        "stop"|"hide"=>{let id=runtime::resolve(&app,&arg)?;runtime::stop(&app,&id)?;Ok(Value::Null)},
        "resume"|"start"=>{let id=runtime::resolve(&app,&arg)?;runtime::resume(&app,&id)?;Ok(Value::Null)},
        "pause"=>{let id=runtime::resolve(&app,&arg)?;runtime::command(&app,&id,"pause",Value::Null);Ok(Value::Null)},
        "volume"=>{let id=runtime::resolve(&app,&arg)?;let v=arg.as_f64().or(arg["volume"].as_f64()).filter(|v|v.is_finite()&&*v>=0.&&*v<=1.).ok_or("Invalid volume")?;runtime::volume(&app,&id,v);Ok(Value::Null)},
        "exit"=>{app.exit(0);Ok(Value::Null)},
        _=>Err("Unsupported command".into())
    }
}
fn media_response(media:&Mutex<HashMap<String,Media>>, request:tauri::http::Request<Vec<u8>>)->tauri::http::Response<Vec<u8>>{
    let response=||->Result<tauri::http::Response<Vec<u8>>,String>{
        if !["GET","HEAD"].contains(&request.method().as_str()){return Err("Method denied".into())}
        let key=request.uri().path().trim_start_matches('/');let m=media.lock().unwrap().get(key).cloned().ok_or("Media not registered")?;
        let mut f=File::open(&m.path).map_err(|e|e.to_string())?;let total=f.metadata().map_err(|e|e.to_string())?.len();
        if total!=m.bytes{return Err("Media changed".into())}
        if total==0{return Err("Empty media".into())}let mut start=0u64;let mut end=total-1;let mut status=200;
        if let Some(h)=request.headers().get("range") {
            let raw=h.to_str().map_err(|e|e.to_string())?.strip_prefix("bytes=").ok_or("Invalid range")?;
            let (a,b)=raw.split_once('-').ok_or("Invalid range")?;start=a.parse().map_err(|_|"Invalid start")?;
            if !b.is_empty(){end=b.parse::<u64>().map_err(|_|"Invalid end")?.min(end)}
            if start>end{return Ok(tauri::http::Response::builder().status(416).header("Content-Range",format!("bytes */{total}")).body(vec![]).unwrap())}
            end=end.min(start+4*1024*1024-1);status=206;
        }
        let mime=if key.ends_with(".mp4"){"video/mp4"}else if key.ends_with(".png"){"image/png"}else if key.ends_with(".jpg"){"image/jpeg"}else{"application/octet-stream"};
        let mut r=tauri::http::Response::builder().status(status).header("Content-Type",mime)
            .header("Access-Control-Allow-Origin","http://tauri.localhost").header("Accept-Ranges","bytes")
            .header("Content-Length",(end-start+1).to_string()).header("X-Content-Type-Options","nosniff");
        if status==206{r=r.header("Content-Range",format!("bytes {start}-{end}/{total}"));}
        let mut bytes=vec![];if request.method()!="HEAD"{ f.seek(SeekFrom::Start(start)).map_err(|e|e.to_string())?;
            f.take(end-start+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;}
        r.body(bytes).map_err(|e|e.to_string())
    };
    response().unwrap_or_else(|e|tauri::http::Response::builder().status(403).body(e.into_bytes()).unwrap())
}
fn main(){
    let args:Vec<String>=std::env::args().collect();let argument=|key:&str|args.iter().position(|v|v==key).and_then(|i|args.get(i+1)).cloned();
    let catalog=argument("--catalog").map(PathBuf::from).unwrap_or_else(||std::env::current_exe().unwrap().with_file_name("trial-catalog.json"));
    let mut presets:Vec<Preset>=fs::read(&catalog).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut media=HashMap::new();let mut checked=HashMap::new();
    presets.retain(|p|{
        if p.id.is_empty()||!p.id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return false}
        for (name,m) in &p.files {if name.contains("..")||name.contains('%')||name.contains('\\'){return false}
            if fs::metadata(&m.path).map(|v|v.len()).ok()!=Some(m.bytes){return false}let actual=checked.entry(m.path.clone()).or_insert_with(||hash(&m.path).unwrap_or_default());if *actual!=m.sha256{return false}}
        for(name,m)in &p.files{media.insert(format!("{}/{}",p.id,name),m.clone());}true
    });
    let library_root=argument("--library").map(PathBuf::from).unwrap_or_else(||PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("ScreenMate/library"));
    let lib=Arc::new(library::Library::open(library_root,argument("--market-port").and_then(|s|s.parse().ok()).unwrap_or(0)).expect("Could not open library"));
    if let Some(file)=argument("--import"){if let Err(e)=lib.import(Path::new(&file),None){eprintln!("Import failed: {e}");}}
    let saved=fs::read(lib.root.join("selected.json")).ok().and_then(|b|serde_json::from_slice::<String>(&b).ok());
    let selected=argument("--preset").or(saved).filter(|id|presets.iter().any(|p|&p.id==id)||id.strip_prefix("local:").and_then(|s|lib.get(s).ok()).map(|e|e.ready).unwrap_or(false)).unwrap_or_else(||presets.first().map(|p|p.id.clone()).unwrap_or_default());
    let attach_on_start=!args.iter().any(|v|v=="--windowed");let probe=args.iter().any(|v|v=="--probe");
    let media=Arc::new(Mutex::new(media));let protocol_media=media.clone();
    let enabled=fs::read(lib.root.join("playback-enabled.json")).ok().and_then(|b|serde_json::from_slice::<bool>(&b).ok()).unwrap_or(true);
    let language=fs::read(lib.root.join("preferences.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).and_then(|v|v["language"].as_str().map(String::from)).filter(|v|["zh-CN","en","ja"].contains(&v.as_str())).unwrap_or("zh-CN".into());
    let official_source=argument("--official-store").map(PathBuf::from);
    let official_catalog=official::initial(&lib,official_source.as_deref());
    let display_config=fs::read(lib.root.join("displays.json")).ok().and_then(|b|serde_json::from_slice::<displays::Config>(&b).ok()).unwrap_or_default();
    let state=Trial{displays:Mutex::new(display_config),enabled:AtomicBool::new(enabled),transition:Mutex::new(()),language:Mutex::new(language),tray_items:Mutex::new(vec![]),desktop_mode:attach_on_start,presets:Mutex::new(presets),official_catalog:Mutex::new(official_catalog),official_source,selected:Mutex::new(selected),report:argument("--report").map(PathBuf::from),library:lib,media};
    official::restore(&state);official::register_covers(&state);
    if let Some(saved)=fs::read(state.library.root.join("selected.json")).ok().and_then(|b|serde_json::from_slice::<String>(&b).ok()){if current_payload(&state,&saved).is_ok(){*state.selected.lock().unwrap()=saved;}}
    for e in state.library.entries.lock().unwrap().iter(){register_entry(&state,e);}
    tauri::Builder::default().plugin(tauri_plugin_wallpaper::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{
            if event.state()==ShortcutState::Pressed {let app=app.clone();std::thread::spawn(move||{runtime::all_command(&app,"stop");});}
        }).build())
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("scene",move|_context,request,responder|{let m=protocol_media.clone();std::thread::spawn(move||responder.respond(media_response(&m,request)));})
        .invoke_handler(tauri::generate_handler![call])
        .setup(move|app|{
            runtime::ensure(app.handle()).map_err(std::io::Error::other)?;
            let handle=app.handle().clone();std::thread::spawn(move||{let _=runtime::reconcile(&handle);desktop::watch(handle);});
            app.global_shortcut().register(Shortcut::new(Some(Modifiers::CONTROL|Modifiers::ALT|Modifiers::SHIFT),Code::KeyH))?;
            if !probe{open_controls(app.handle())?;}
            let menu=Menu::new(app)?;
            let lang=app.state::<Trial>().language.lock().unwrap().clone();
            for id in ["controls","pause","resume","stop","mute","sound","exit"] {
                let item=MenuItem::with_id(app,id,runtime::tray_text(id,&lang),true,None::<&str>)?;
                menu.append(&item)?;app.state::<Trial>().tray_items.lock().unwrap().push((id.into(),item));
            }
            TrayIconBuilder::new().icon(tauri::image::Image::from_bytes(include_bytes!("../../../../assets/brand/native/screenmate-128.png"))?).tooltip("SofaMate").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray,event|{
                if let TrayIconEvent::DoubleClick{button:MouseButton::Left,..}=event {
                    let app=tray.app_handle().clone();std::thread::spawn(move||{let _=open_controls(&app);});
                }
            }).on_menu_event(|app,event|{
                let app=app.clone();let id=event.id.as_ref().to_string();
                std::thread::spawn(move||{match id.as_str(){
                    "controls"=>{let _=open_controls(&app);},"exit"=>app.exit(0),
                    _=>runtime::all_command(&app,&id)

                }});
            }).build(app)?;Ok(())
        }).build(tauri::generate_context!()).expect("SofaMate failed to start").run(|_,event|{
            if let tauri::RunEvent::ExitRequested{code:None,api,..}=event {api.prevent_exit();}
        });
}
