import { open } from 'node:fs/promises';

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  codec: 'h264';
}
type Box = { type: string; start: number; end: number };
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function boxes(b: Buffer, start = 0, end = b.length): Box[] {
  const result: Box[] = [];
  while (start < end) {
    check(start + 8 <= end, 'MP4 结构不完整');
    let size = b.readUInt32BE(start),
      header = 8;
    if (size === 1) {
      check(start + 16 <= end, 'MP4 结构不完整');
      size = Number(b.readBigUInt64BE(start + 8));
      header = 16;
    }
    if (size === 0) size = end - start;
    check(Number.isSafeInteger(size) && size >= header && start + size <= end, 'MP4 数据长度无效');
    result.push({
      type: b.toString('ascii', start + 4, start + 8),
      start: start + header,
      end: start + size,
    });
    check(result.length < 100000, 'MP4 结构超出限制');
    start += size;
  }
  return result;
}
function child(b: Buffer, box: Box, name: string): Box {
  const found = boxes(b, box.start, box.end).find((x) => x.type === name);
  check(found, `MP4 缺少 ${name}`);
  return found;
}
// Read only bounded metadata, never buffer the uploaded video in memory.
export async function inspectVideo(file: string): Promise<VideoInfo> {
  const f = await open(file, 'r');
  try {
    const { size: total } = await f.stat();
    check(total >= 32 && total <= MAX_VIDEO_BYTES, '视频大小须在 32 字节至 1GB 之间');
    let offset = 0,
      moov: Buffer | undefined,
      ftyp = false,
      mdat = false,
      count = 0;
    while (offset < total) {
      const h = Buffer.alloc(16);
      const { bytesRead } = await f.read(h, 0, Math.min(16, total - offset), offset);
      check(bytesRead >= 8, 'MP4 结构不完整');
      let size = h.readUInt32BE(0),
        header = 8;
      const type = h.toString('ascii', 4, 8);
      if (size === 1) {
        check(bytesRead === 16, 'MP4 结构不完整');
        size = Number(h.readBigUInt64BE(8));
        header = 16;
      }
      if (!size) size = total - offset;
      check(
        Number.isSafeInteger(size) && size >= header && offset + size <= total && ++count < 100000,
        'MP4 数据长度无效',
      );
      check(type !== 'moof', '暂不支持分片 MP4，请导出标准 MP4');
      if (type === 'ftyp') ftyp = true;
      if (type === 'mdat' && size > header) mdat = true;
      if (type === 'moov') {
        check(!moov && size <= 8 * 1024 * 1024, 'MP4 元数据超出限制');
        moov = Buffer.alloc(size - header);
        check(
          (await f.read(moov, 0, moov.length, offset + header)).bytesRead === moov.length,
          'MP4 元数据不完整',
        );
      }
      offset += size;
    }
    check(ftyp && mdat && moov, '请选择有效的 MP4 视频');
    const root: Box = { type: 'moov', start: 0, end: moov.length };
    let video: VideoInfo | undefined;
    for (const track of boxes(moov).filter((b) => b.type === 'trak')) {
      const mdia = child(moov, track, 'mdia'),
        hdlr = child(moov, mdia, 'hdlr');
      check(hdlr.start + 12 <= hdlr.end, '媒体轨道无效');
      const kind = moov.toString('ascii', hdlr.start + 8, hdlr.start + 12);
      check(kind === 'vide' || kind === 'soun', '暂不支持此 MP4 轨道，请导出 H.264 / AAC MP4');
      const minf = child(moov, mdia, 'minf'),
        dinf = child(moov, minf, 'dinf'),
        dref = child(moov, dinf, 'dref');
      check(dref.start + 8 <= dref.end, '数据引用无效');
      const refs = boxes(moov, dref.start + 8, dref.end);
      check(refs.length > 0, '缺少媒体数据');
      for (const ref of refs)
        check(
          ref.type === 'url ' && ref.start + 4 <= ref.end && (moov.readUInt32BE(ref.start) & 1) === 1,
          '不支持外部媒体引用',
        );
      const stsd = child(moov, child(moov, minf, 'stbl'), 'stsd');
      check(stsd.start + 8 <= stsd.end, '编码信息无效');
      const samples = boxes(moov, stsd.start + 8, stsd.end);
      check(samples.length === 1 && moov.readUInt32BE(stsd.start + 4) === 1, '暂不支持多编码视频');
      const sample = samples[0];
      if (kind === 'soun') {
        check(sample.type === 'mp4a', '音频需要 AAC 编码，或导出无声视频');
        continue;
      }
      check(!video && sample.type === 'avc1' && sample.start + 78 <= sample.end, '视频需要 H.264 编码的 MP4');
      const width = moov.readUInt16BE(sample.start + 24),
        height = moov.readUInt16BE(sample.start + 26);
      check(width > 0 && height > 0 && width <= 8192 && height <= 8192, '视频尺寸超出限制');
      const mdhd = child(moov, mdia, 'mdhd'),
        version = moov[mdhd.start];
      check(version === 0 || version === 1, '时间信息无效');
      const pos = mdhd.start + (version === 1 ? 20 : 12);
      check(pos + (version === 1 ? 12 : 8) <= mdhd.end, '时间信息不完整');
      const scale = moov.readUInt32BE(pos),
        ticks = version === 1 ? Number(moov.readBigUInt64BE(pos + 4)) : moov.readUInt32BE(pos + 4);
      const duration = ticks / scale;
      check(
        Number.isFinite(duration) && duration >= 0.1 && duration <= 21600,
        '视频时长须在 0.1 秒至 6 小时之间',
      );
      video = { width, height, duration, codec: 'h264' };
    }
    check(video, 'MP4 中没有视频轨道');
    return video;
  } finally {
    await f.close();
  }
}

export function inspectJpeg(b: Buffer): void {
  check(
    b.length >= 32 &&
      b.length <= 1024 * 1024 &&
      b.readUInt16BE(0) === 0xffd8 &&
      b.readUInt16BE(b.length - 2) === 0xffd9,
    '预览图需要有效 JPEG，且小于 1MB',
  );
  let i = 2,
    dimensions = false;
  while (i + 4 <= b.length) {
    check(b[i] === 0xff, 'JPEG 结构无效');
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const n = b.readUInt16BE(i + 2);
    check(n >= 2 && i + n + 2 <= b.length, 'JPEG 长度无效');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      check(n >= 8, 'JPEG 尺寸无效');
      const height = b.readUInt16BE(i + 5),
        width = b.readUInt16BE(i + 7);
      check(width > 0 && height > 0 && width <= 1920 && height <= 1920, '预览图尺寸超出限制');
      dimensions = true;
    }
    i += n + 2;
  }
  check(dimensions, 'JPEG 缺少尺寸信息');
}
