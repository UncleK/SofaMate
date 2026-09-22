use std::{thread,time::Duration};
use serde_json::{json,Value};
use tauri::{Emitter,Manager,WebviewUrl,WebviewWindowBuilder};
use crate::{Trial,current_payload,library,desktop,displays::{self,Display,Screen},WEBVIEW_ARGS};

fn save(state:&Trial)->Result<(),String>{library::save_json(&state.library.root.join("displays.json"),&*state.displays.lock().unwrap())}
pub fn target(state:&Trial)->String{state.displays.lock().unwrap().target.clone()}
pub fn resolve(app:&tauri::AppHandle,arg:&Value)->Result<String,String>{
    let id=arg["monitorId"].as_str().map(String::from).unwrap_or_else(||target(&app.state::<Trial>()));
    if displays::list(app)?.iter().any(|d|d.id==id){Ok(id)}else{Err("显示器已断开".into())}
}
pub fn window_id(state:&Trial,label:&str)->Option<String>{label.strip_prefix("wallpaper-").filter(|id|state.displays.lock().unwrap().screens.contains_key(*id)).map(String::from)}
pub fn selected(state:&Trial,id:&str)->String{state.displays.lock().unwrap().screens.get(id).map(|s|s.selected.clone()).unwrap_or_default()}
pub fn fit(state:&Trial)->String{let id=target(state);state.displays.lock().unwrap().screens.get(&id).map(|s|s.fit.clone()).unwrap_or("cover".into())}
pub fn payload(state:&Trial,id:&str)->Result<Value,String>{
    let screen=state.displays.lock().unwrap().screens.get(id).cloned().ok_or("显示器不存在")?;
    let mut value=current_payload(state,&screen.selected)?;
    value["selectionId"]=json!(screen.selected);value["playbackId"]=json!(screen.generation);value["monitorId"]=json!(id);
    value["volume"]=json!(screen.volume);value["fit"]=json!(screen.fit);Ok(value)
}
pub fn metrics(app:&tauri::AppHandle,id:&str)->Value{
    let state=app.state::<Trial>();let s=state.displays.lock().unwrap().screens.get(id).cloned();let window=app.get_webview_window(&format!("wallpaper-{id}"));
    json!({"monitorId":id,"playback":s.as_ref().map(|s|s.metrics.clone()).unwrap_or(json!({"stopped":true,"paused":true})),"selected":s.as_ref().map(|s|s.selected.clone()),"enabled":s.as_ref().map(|s|s.enabled).unwrap_or(false),"windowPresent":window.is_some(),"attached":window.as_ref().map(desktop::is_attached).unwrap_or(false)})
}
pub fn snapshot(app:&tauri::AppHandle)->Result<Value,String>{
    let state=app.state::<Trial>();let target=target(&state);
    let monitors=displays::list(app)?.into_iter().map(|d|{let mut v=serde_json::to_value(&d).unwrap();v["state"]=metrics(app,&d.id);v["fit"]=json!(state.displays.lock().unwrap().screens.get(&d.id).map(|s|s.fit.clone()).unwrap_or("cover".into()));v}).collect::<Vec<_>>();
    Ok(json!({"target":target,"monitors":monitors}))
}
fn changed(app:&tauri::AppHandle){if let Ok(v)=snapshot(app){let _=app.emit_to("controls","displays-changed",v);}}
pub fn set_target(app:&tauri::AppHandle,id:&str)->Result<Value,String>{
    resolve(app,&json!({"monitorId":id}))?;let state=app.state::<Trial>();state.displays.lock().unwrap().target=id.into();save(&state)?;
    changed(app);let m=metrics(app,id);let _=app.emit_to("controls","trial-metrics",m["playback"].clone());Ok(m)
}
pub fn publish(app:&tauri::AppHandle,id:&str,mut value:Value){
    let state=app.state::<Trial>();value["monitorId"]=json!(id);
    if let Some(s)=state.displays.lock().unwrap().screens.get_mut(id){s.metrics=value.clone();}
    if let Some(path)=&state.report {let all=state.displays.lock().unwrap().screens.iter().map(|(id,s)|(id.clone(),s.metrics.clone())).collect::<serde_json::Map<_,_>>();let mut report=value.clone();report["displays"]=json!(all);let _=std::fs::write(path,serde_json::to_vec_pretty(&report).unwrap());}
    if target(&state)==id {let _=app.emit_to("controls","trial-metrics",value);}
}
pub fn accept_metrics(app:&tauri::AppHandle,id:&str,value:Value){
    let valid={let state=app.state::<Trial>();let c=state.displays.lock().unwrap();c.screens.get(id).map(|s|s.enabled&&value["playbackId"].as_u64()==Some(s.generation)&&value["selectionId"].as_str()==Some(s.selected.as_str())).unwrap_or(false)};
    if valid{publish(app,id,value)}
}
pub fn command(app:&tauri::AppHandle,id:&str,action:&str,value:Value){
    let label=format!("wallpaper-{id}");let _=app.emit_to(&label,"trial-command",json!({"action":action,"payload":value}));
    if action=="resume"{if let Some(w)=app.get_webview_window(&label){let _=desktop::show(&w);}}
}
fn open_player(app:&tauri::AppHandle,monitor:&Display)->Result<(),String>{
    let state=app.state::<Trial>();let mut builder=WebviewWindowBuilder::new(app,monitor.window(),WebviewUrl::App("index.html?wallpaper=1".into()))
        .title(format!("SofaMate · {}",monitor.label)).visible(false).decorations(false).resizable(false).skip_taskbar(state.desktop_mode).focused(false)
        .inner_size(monitor.width as f64/monitor.scale,monitor.height as f64/monitor.scale)
        .position(monitor.x as f64/monitor.scale,monitor.y as f64/monitor.scale).additional_browser_args(WEBVIEW_ARGS);
    if !state.desktop_mode{builder=builder.inner_size(1152.,648.).position(30.,30.);}
    let window=builder.build().map_err(|e|e.to_string())?;
    window.set_icon(tauri::image::Image::from_bytes(include_bytes!("../../../../assets/brand/native/screenmate-128.png")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if state.desktop_mode{desktop::attach(app,&window,monitor)?;}desktop::show(&window)
}
pub fn start(app:&tauri::AppHandle,monitor_id:&str,id:&str)->Result<(),String>{
    start_inner(app,monitor_id,id,None)
}
fn start_inner(app:&tauri::AppHandle,monitor_id:&str,id:&str,expected:Option<u64>)->Result<(),String>{
    let state=app.state::<Trial>();let _transition=state.transition.lock().unwrap();current_payload(&state,id)?;if id.is_empty(){return Err("本机壁纸不存在".into())}
    if let Some(generation)=expected {let c=state.displays.lock().unwrap();let s=c.screens.get(monitor_id).ok_or("显示器不存在")?;if !s.enabled||s.generation!=generation||s.selected!=id||app.get_webview_window(&format!("wallpaper-{monitor_id}")).is_some(){return Ok(())}}
    let monitor=displays::list(app)?.into_iter().find(|d|d.id==monitor_id).ok_or("显示器已断开")?;
    {let mut c=state.displays.lock().unwrap();let s=c.screens.get_mut(monitor_id).ok_or("显示器不存在")?;s.selected=id.into();s.enabled=true;s.generation+=1;}
    save(&state)?;let p=payload(&state,monitor_id)?;
    publish(app,monitor_id,json!({"monitorId":monitor_id,"selectionId":id,"playbackId":p["playbackId"],"loading":true,"stopped":false,"paused":true,"frames":0,"fault":null,"volume":p["volume"]}));
    let result=if let Some(w)=app.get_webview_window(&monitor.window()){desktop::show(&w)?;app.emit_to(w.label(),"trial-command",json!({"action":"load","payload":p})).map_err(|e|e.to_string())}else{open_player(app,&monitor)};
    if let Err(error)=&result {
        if let Some(w)=app.get_webview_window(&monitor.window()){let _=w.hide();let _=w.destroy();}
        {let mut c=state.displays.lock().unwrap();let s=c.screens.get_mut(monitor_id).unwrap();s.enabled=false;s.generation+=1;}let _=save(&state);
        publish(app,monitor_id,json!({"monitorId":monitor_id,"stopped":true,"paused":true,"fault":error,"frames":0}));
    }changed(app);result
}
pub fn stop(app:&tauri::AppHandle,id:&str)->Result<(),String>{
    let state=app.state::<Trial>();let _transition=state.transition.lock().unwrap();
    {let mut c=state.displays.lock().unwrap();let s=c.screens.get_mut(id).ok_or("显示器不存在")?;s.enabled=false;s.generation+=1;}save(&state)?;
    destroy(app,id)?;publish(app,id,json!({"monitorId":id,"stopped":true,"paused":true,"frames":0,"videoSlots":0,"fault":null}));changed(app);Ok(())
}
fn destroy(app:&tauri::AppHandle,id:&str)->Result<(),String>{let label=format!("wallpaper-{id}");if let Some(w)=app.get_webview_window(&label){w.hide().map_err(|e|e.to_string())?;w.destroy().map_err(|e|e.to_string())?;for _ in 0..100{if app.get_webview_window(&label).is_none(){return Ok(())}thread::sleep(Duration::from_millis(10));}return Err("播放器仍在释放，请稍候".into())}Ok(())}
pub fn resume(app:&tauri::AppHandle,id:&str)->Result<(),String>{
    if app.get_webview_window(&format!("wallpaper-{id}")).is_none(){return start(app,id,&selected(&app.state::<Trial>(),id))}command(app,id,"resume",Value::Null);Ok(())
}
pub fn volume(app:&tauri::AppHandle,id:&str,value:f64){if let Some(s)=app.state::<Trial>().displays.lock().unwrap().screens.get_mut(id){s.volume=value;}command(app,id,"volume",json!(value));}
pub fn set_fit(app:&tauri::AppHandle,id:&str,fit:&str)->Result<(),String>{
    if fit!="cover"&&fit!="contain"{return Err("Invalid fit".into())}let state=app.state::<Trial>();if let Some(s)=state.displays.lock().unwrap().screens.get_mut(id){s.fit=fit.into();}save(&state)?;command(app,id,"fit",json!(fit));changed(app);Ok(())
}
pub fn all_command(app:&tauri::AppHandle,action:&str){if let Ok(monitors)=displays::list(app){for d in monitors{match action{"stop"=>{let _=stop(app,&d.id);},"resume"=>{let _=resume(app,&d.id);},"mute"=>volume(app,&d.id,0.),"sound"=>volume(app,&d.id,0.5),_=>command(app,&d.id,action,Value::Null)}}}}
pub fn ensure(app:&tauri::AppHandle)->Result<Vec<Display>,String>{
    let state=app.state::<Trial>();let monitors=displays::list(app)?;if monitors.is_empty(){return Ok(monitors)}let primary=&monitors[0];let mut dirty=false;
    {let mut c=state.displays.lock().unwrap();let template=c.screens.get(&primary.id).cloned().unwrap_or_else(||Screen::new(state.selected.lock().unwrap().clone(),state.enabled.load(std::sync::atomic::Ordering::SeqCst),"cover".into()));
        for d in &monitors{if !c.screens.contains_key(&d.id){c.screens.insert(d.id.clone(),Screen::new(template.selected.clone(),template.enabled,template.fit.clone()));dirty=true;}}
        if !monitors.iter().any(|d|d.id==c.target){c.target=primary.id.clone();dirty=true;}}
    if dirty{save(&state)?;changed(app);}
    Ok(monitors)
}
pub fn reconcile(app:&tauri::AppHandle)->Result<(),String>{
    let monitors=ensure(app)?;let state=app.state::<Trial>();
    for(label,w)in app.webview_windows(){if let Some(id)=window_id(&state,&label){if !monitors.iter().any(|d|d.id==id){let _=w.hide();let _=w.destroy();}}}
    for d in monitors {
        let s=state.displays.lock().unwrap().screens.get(&d.id).cloned().unwrap();
        if s.enabled&&!s.selected.is_empty(){if let Some(w)=app.get_webview_window(&d.window()){if state.desktop_mode&&(!desktop::is_attached(&w)||!desktop::fits(&w,&d)){desktop::attach(app,&w,&d)?;desktop::show(&w)?;}}else{start_inner(app,&d.id,&s.selected,Some(s.generation))?;}}
    }Ok(())
}
pub fn tray_text(id:&str,lang:&str)->&'static str {let i=if lang=="en"{1}else if lang=="ja"{2}else{0};match id{
 "controls"=>["打开控制面板","Open controls","コントロールを開く"][i],"pause"=>["暂停全部显示器","Pause all displays","全画面を一時停止"][i],"resume"=>["继续全部显示器","Resume all displays","全画面を再開"][i],"stop"=>["停止全部显示器","Stop all displays","全画面を停止"][i],"mute"=>["全部静音","Mute all","すべてミュート"][i],"sound"=>["开启声音（50%）","Sound on (50%)","音声オン（50%）"][i],_=>["退出 SofaMate","Quit SofaMate","SofaMate を終了"][i]}}
