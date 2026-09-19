use std::{fs::File, io::{Read, Seek, SeekFrom}, path::Path};
use serde::{Serialize, Deserialize};
pub const MAX_BYTES:u64=1024*1024*1024;
#[derive(Clone,Serialize,Deserialize)]
pub struct Info {pub width:u32,pub height:u32,pub duration:f64,pub codec:String}
#[derive(Clone)]
struct BoxInfo {kind:[u8;4],start:usize,end:usize}
fn be32(b:&[u8],i:usize)->Result<u32,String>{Ok(u32::from_be_bytes(b.get(i..i+4).ok_or("MP4 数据不完整")?.try_into().unwrap()))}
fn be64(b:&[u8],i:usize)->Result<u64,String>{Ok(u64::from_be_bytes(b.get(i..i+8).ok_or("MP4 数据不完整")?.try_into().unwrap()))}
fn boxes(b:&[u8],mut i:usize,end:usize)->Result<Vec<BoxInfo>,String>{
 let mut out=vec![];while i<end {if i+8>end{return Err("MP4 结构不完整".into())}let mut n=be32(b,i)? as usize;let mut h=8;
 if n==1{if i+16>end{return Err("MP4 结构不完整".into())}n=usize::try_from(be64(b,i+8)?).map_err(|_|"MP4 过大")?;h=16}if n==0{n=end-i}
 if n<h||n>end-i||out.len()>100000{return Err("MP4 数据长度无效".into())}out.push(BoxInfo{kind:b[i+4..i+8].try_into().unwrap(),start:i+h,end:i+n});i+=n;}Ok(out)
}
fn child(b:&[u8],p:&BoxInfo,kind:&[u8;4])->Result<BoxInfo,String>{boxes(b,p.start,p.end)?.into_iter().find(|v|&v.kind==kind).ok_or_else(||format!("MP4 缺少 {}",String::from_utf8_lossy(kind)))}
pub fn inspect(path:&Path)->Result<Info,String>{
 let mut f=File::open(path).map_err(|e|e.to_string())?;let total=f.metadata().map_err(|e|e.to_string())?.len();
 if !(32..=MAX_BYTES).contains(&total){return Err("视频须小于 1GB".into())}let(mut offset,mut ftyp,mut mdat,mut count)=(0u64,false,false,0);let mut meta=None;
 while offset<total{let mut h=[0u8;16];let n=(total-offset).min(16)as usize;f.seek(SeekFrom::Start(offset)).map_err(|e|e.to_string())?;f.read_exact(&mut h[..n]).map_err(|e|e.to_string())?;
 if n<8{return Err("MP4 结构不完整".into())}let mut size=be32(&h,0)?as u64;let mut header=8;if size==1{if n<16{return Err("MP4 结构不完整".into())}size=be64(&h,8)?;header=16}if size==0{size=total-offset}count+=1;
 if size<header||size>total-offset||count>100000{return Err("MP4 数据长度无效".into())}
 match &h[4..8]{b"ftyp"=>ftyp=true,b"mdat"=>mdat=size>header,b"moof"=>return Err("暂不支持分片 MP4，请导出标准 MP4".into()),b"moov"=>{
 if meta.is_some()||size>8*1024*1024{return Err("MP4 元数据超出限制".into())}let mut b=vec![0;(size-header)as usize];f.seek(SeekFrom::Start(offset+header)).map_err(|e|e.to_string())?;f.read_exact(&mut b).map_err(|e|e.to_string())?;meta=Some(b);},_=>{}}offset+=size;}
 if !ftyp||!mdat{return Err("请选择有效的 MP4 视频".into())}let b=meta.ok_or("MP4 缺少媒体信息")?;let mut info=None;
 for t in boxes(&b,0,b.len())?.into_iter().filter(|t|&t.kind==b"trak"){
 let mdia=child(&b,&t,b"mdia")?;let hdlr=child(&b,&mdia,b"hdlr")?;if hdlr.start+12>hdlr.end{return Err("轨道信息不完整".into())}let kind=&b[hdlr.start+8..hdlr.start+12];
 if kind!=b"vide"&&kind!=b"soun"{return Err("请导出 H.264 / AAC MP4".into())}let minf=child(&b,&mdia,b"minf")?;let dref=child(&b,&child(&b,&minf,b"dinf")?,b"dref")?;
 if dref.start+8>dref.end{return Err("数据引用无效".into())}let refs=boxes(&b,dref.start+8,dref.end)?;if refs.is_empty(){return Err("缺少媒体数据".into())}
 for r in refs {if &r.kind!=b"url "||r.start+4>r.end||be32(&b,r.start)?&1!=1{return Err("不支持外部媒体引用".into())}}
 let stsd=child(&b,&child(&b,&minf,b"stbl")?,b"stsd")?;if stsd.start+8>stsd.end{return Err("编码信息无效".into())}let samples=boxes(&b,stsd.start+8,stsd.end)?;
 if samples.len()!=1||be32(&b,stsd.start+4)?!=1{return Err("暂不支持多编码视频".into())}let s=&samples[0];
 if kind==b"soun"{if &s.kind!=b"mp4a"{return Err("音频需要 AAC 编码，或使用无声视频".into())}continue}
 if info.is_some()||&s.kind!=b"avc1"||s.start+78>s.end{return Err("视频需要 H.264 编码的 MP4".into())}
 let width=u16::from_be_bytes(b[s.start+24..s.start+26].try_into().unwrap())as u32;let height=u16::from_be_bytes(b[s.start+26..s.start+28].try_into().unwrap())as u32;
 if width==0||height==0||width>8192||height>8192{return Err("视频尺寸超出限制".into())}let mdhd=child(&b,&mdia,b"mdhd")?;let ver=*b.get(mdhd.start).ok_or("时间信息无效")?;
 if ver>1{return Err("时间信息无效".into())}let pos=mdhd.start+if ver==1{20}else{12};if pos+if ver==1{12}else{8}>mdhd.end{return Err("时间信息不完整".into())}
 let scale=be32(&b,pos)?as f64;let ticks=if ver==1{be64(&b,pos+4)?as f64}else{be32(&b,pos+4)?as f64};let duration=ticks/scale;
 if !duration.is_finite()||!(0.1..=21600.).contains(&duration){return Err("视频时长须在 0.1 秒至 6 小时之间".into())}info=Some(Info{width,height,duration,codec:"h264".into()});}
 info.ok_or("MP4 中没有视频轨道".into())
}
pub fn jpeg(b:&[u8])->Result<(),String>{
 if b.len()<32||b.len()>1024*1024||b[..2]!=[255,216]||b[b.len()-2..]!=[255,217]{return Err("预览图需要小于 1MB 的 JPEG".into())}let mut i=2;let mut found=false;
 while i+4<=b.len(){if b[i]!=255{return Err("JPEG 结构无效".into())}let marker=b[i+1];if marker==218||marker==217{break}let n=u16::from_be_bytes([b[i+2],b[i+3]])as usize;if n<2||i+n+2>b.len(){return Err("JPEG 长度无效".into())}
 if [192,193,194].contains(&marker){if n<8{return Err("JPEG 尺寸无效".into())}let h=u16::from_be_bytes([b[i+5],b[i+6]]);let w=u16::from_be_bytes([b[i+7],b[i+8]]);if h==0||w==0||h>1600||w>1600{return Err("预览图尺寸超出限制".into())}found=true}i+=n+2;}
 if !found{return Err("JPEG 缺少尺寸信息".into())}Ok(())
}
