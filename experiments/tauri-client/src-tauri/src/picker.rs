use std::{ffi::c_void,path::PathBuf};
#[repr(C)]
struct OpenFileName {size:u32,owner:isize,instance:isize,filter:*const u16,custom:*mut u16,max_custom:u32,index:u32,file:*mut u16,max_file:u32,file_title:*mut u16,max_title:u32,initial:*const u16,title:*const u16,flags:u32,file_offset:u16,extension:u16,default_ext:*const u16,data:isize,hook:*const c_void,template:*const u16,reserved:*mut c_void,reserved2:u32,flags_ex:u32}
#[link(name="comdlg32")]
unsafe extern "system" {fn GetOpenFileNameW(p:*mut OpenFileName)->i32;fn CommDlgExtendedError()->u32;}
pub fn video(owner:isize,language:&str)->Result<Option<PathBuf>,String>{
 let filter:Vec<u16>=(match language {"en"=>"MP4 video (H.264)\0*.mp4\0\0","ja"=>"MP4 動画 (H.264)\0*.mp4\0\0",_=>"MP4 视频 (H.264)\0*.mp4\0\0"}).encode_utf16().collect();let title:Vec<u16>=(match language {"en"=>"Choose a wallpaper video\0","ja"=>"壁紙用の動画を選択\0",_=>"选择桌面壁纸视频\0"}).encode_utf16().collect();let mut file=vec![0u16;32768];
 let mut p:OpenFileName=unsafe{std::mem::zeroed()};p.size=std::mem::size_of::<OpenFileName>()as u32;p.owner=owner;p.filter=filter.as_ptr();p.index=1;p.file=file.as_mut_ptr();p.max_file=file.len()as u32;p.title=title.as_ptr();p.flags=0x00080000|0x00001000|0x00000800|0x00000008|0x02000000;
 if unsafe{GetOpenFileNameW(&mut p)}==0{let code=unsafe{CommDlgExtendedError()};if code==0{return Ok(None)}return Err(format!("文件选择失败：{code}"))}let n=file.iter().position(|v|*v==0).unwrap_or(file.len());Ok(Some(PathBuf::from(String::from_utf16(&file[..n]).map_err(|_|"文件名无效")?)))
}
