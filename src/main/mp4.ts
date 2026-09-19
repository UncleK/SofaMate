import { ensure } from '../core/validate';
// Small, bounded ISO BMFF reader. Runtime needs no FFmpeg installation.
interface Box {
  type: string;
  start: number;
  end: number;
}
function boxes(b: Buffer, start = 0, end = b.length): Box[] {
  const out: Box[] = [];
  while (start < end) {
    ensure(start + 8 <= end, 'Truncated MP4 box');
    let size = b.readUInt32BE(start),
      header = 8;
    const type = b.toString('ascii', start + 4, start + 8);
    if (size === 1) {
      ensure(start + 16 <= end, 'Truncated large box');
      size = Number(b.readBigUInt64BE(start + 8));
      header = 16;
    }
    if (size === 0) size = end - start;
    ensure(Number.isSafeInteger(size) && size >= header && start + size <= end, 'Invalid MP4 box length');
    out.push({ type, start: start + header, end: start + size });
    ensure(out.length < 100000, 'MP4 box count limit');
    start += size;
  }
  return out;
}
function child(b: Buffer, parent: Box, name: string) {
  const c = boxes(b, parent.start, parent.end).find((x) => x.type === name);
  ensure(c, `MP4 missing ${name}`);
  return c;
}
export function mp4Info(b: Buffer) {
  const top = boxes(b);
  ensure(
    top.some((x) => x.type === 'ftyp') &&
      top.some((x) => x.type === 'mdat') &&
      !top.some((x) => x.type === 'moof'),
    'Only self-contained MP4 is supported',
  );
  const moov = top.find((x) => x.type === 'moov');
  ensure(moov, 'Missing moov');
  const video = [];
  for (const track of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, track, 'mdia'),
      hdlr = child(b, mdia, 'hdlr');
    if (b.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const minf = child(b, mdia, 'minf'),
      stbl = child(b, minf, 'stbl');
    const dinf = child(b, minf, 'dinf'),
      dref = child(b, dinf, 'dref');
    for (const ref of boxes(b, dref.start + 8, dref.end))
      ensure(
        ref.type === 'url ' && (b.readUInt32BE(ref.start) & 1) === 1,
        'External media reference forbidden',
      );
    const stsd = child(b, stbl, 'stsd');
    ensure(b.readUInt32BE(stsd.start + 4) === 1, 'Multiple sample descriptions unsupported');
    const sample = boxes(b, stsd.start + 8, stsd.end)[0];
    ensure(sample?.type === 'avc1', 'Only H.264 MP4 is supported');
    const width = b.readUInt16BE(sample.start + 24),
      height = b.readUInt16BE(sample.start + 26);
    const stsz = child(b, stbl, 'stsz'),
      frameCount = b.readUInt32BE(stsz.start + 8);
    const mdhd = child(b, mdia, 'mdhd'),
      v = b[mdhd.start];
    ensure(v === 0 || v === 1, 'Invalid media header');
    const timescale = b.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
    const stts = child(b, stbl, 'stts'),
      entries = b.readUInt32BE(stts.start + 4);
    ensure(entries > 0 && entries < 100000 && stts.start + 8 + entries * 8 <= stts.end, 'Invalid time table');
    const delta = b.readUInt32BE(stts.start + 12);
    let counted = 0;
    for (let i = 0; i < entries; i++) {
      counted += b.readUInt32BE(stts.start + 8 + i * 8);
      ensure(
        b.readUInt32BE(stts.start + 12 + i * 8) === delta,
        'Variable frame rate must be normalized offline',
      );
    }
    ensure(delta > 0 && timescale > 0 && counted === frameCount, 'Invalid frame timing');
    const gcd = (a: number, c: number): number => (c ? gcd(c, a % c) : a),
      d = gcd(timescale, delta);
    video.push({
      width,
      height,
      frameCount,
      fpsNumerator: timescale / d,
      fpsDenominator: delta / d,
      duration: (frameCount * delta) / timescale,
    });
  }
  ensure(video.length === 1, 'Expected exactly one video track');
  return video[0];
}
