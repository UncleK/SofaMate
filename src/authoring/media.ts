import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { ensure } from '../core/validate';
import { hashFile, writeJson } from '../main/files';
import path from 'node:path';
const exec = promisify(execFile);
export async function command(tool: string, args: string[], timeout = 120000) {
  try {
    return await exec(tool, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (e: any) {
    throw new Error(`${tool}: ${String(e.stderr || e.message).slice(-3000)}`);
  }
}
export async function probe(file: string) {
  const { stdout } = await command('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ]);
  const raw = JSON.parse(stdout),
    s = raw.streams?.[0];
  ensure(
    s && s.width > 0 && s.height > 0 && s.width <= 8192 && s.height <= 4096,
    'Unsupported video dimensions',
  );
  const frameCount = Number(s.nb_read_frames);
  ensure(
    Number.isSafeInteger(frameCount) && frameCount > 0 && frameCount <= 216000,
    'Video frame limit or damaged media',
  );
  const [n, d] = String(s.avg_frame_rate).split('/').map(Number);
  ensure(n > 0 && d > 0 && n / d <= 120, 'Invalid frame rate');
  ensure(
    !['smpte2084', 'arib-std-b67'].includes(s.color_transfer),
    'Convert HDR to the approved SDR profile before import; automatic tone mapping is not performed',
  );
  return {
    width: s.width as number,
    height: s.height as number,
    frameCount,
    fpsNumerator: n,
    fpsDenominator: d,
    timeBase: s.time_base as string,
    duration: Number(s.duration ?? raw.format.duration),
    codec: s.codec_name as string,
    raw,
  };
}
export async function extractFrame(file: string, frame: number, out: string) {
  const info = await probe(file);
  ensure(Number.isSafeInteger(frame) && frame >= 0 && frame < info.frameCount, 'Frame out of range');
  const { stdout } = await command('ffprobe', [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=best_effort_timestamp,best_effort_timestamp_time',
    '-of',
    'json',
    file,
  ]);
  const selected = JSON.parse(stdout).frames[frame];
  ensure(selected, 'Missing frame PTS');
  await command('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-protocol_whitelist',
    'file,pipe',
    '-noautorotate',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-vf',
    `select=eq(n\\,${frame})`,
    '-fps_mode',
    'vfr',
    '-frames:v',
    '1',
    out,
  ]);
  const record = {
    sourceVideoSha256: await hashFile(file),
    frameIndexZeroBased: frame,
    pts: selected.best_effort_timestamp,
    ptsTimeSec: selected.best_effort_timestamp_time,
    timeBase: info.timeBase,
    width: info.width,
    height: info.height,
    imageSha256: await hashFile(out),
    createdAt: new Date().toISOString(),
  };
  await writeJson(out.replace(/\.png$/, '.frame.json'), record);
  return record;
}
export async function trimVideo(file: string, start: number, end: number, out: string, fps: string) {
  const input = await probe(file);
  ensure(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      end > start &&
      end <= input.frameCount,
    'Invalid half-open trim',
  );
  // No frame-rate resampling is hidden in a trim: preserve the input clock.
  const [n, d] = fps.split('/').map(Number);
  ensure(
    Math.abs(input.fpsNumerator / input.fpsDenominator - n / d) < 1e-6,
    'Normalize frame rate before importing this take',
  );
  await command('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-protocol_whitelist',
    'file,pipe',
    '-noautorotate',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    `trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS`,
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-bf',
    '0',
    '-movflags',
    '+faststart',
    out,
  ]);
  const actual = await probe(out);
  ensure(actual.frameCount === end - start, 'Export changed selected frame count');
  return actual;
}
export async function decodeCheck(file: string) {
  await command('ffmpeg', [
    '-v',
    'error',
    '-xerror',
    '-nostdin',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-',
  ]);
}
export async function requireRegular(file: string) {
  const s = await fs.lstat(file);
  ensure(
    s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size > 0 && s.size <= 512 * 1024 * 1024,
    'Expected a bounded regular file',
  );
}
export async function packAlpha(rgb: string, matte: string, out: string) {
  await requireRegular(rgb);
  await requireRegular(matte);
  ensure(path.extname(out).toLowerCase() === '.mp4', 'Packed output must be MP4');
  for (const filename of [out, out + '.packing.json']) {
    try {
      await fs.lstat(filename);
      throw new Error('Output exists; select a new immutable version');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const color = await probe(rgb),
    alpha = await probe(matte);
  ensure(
    color.width === alpha.width &&
      color.height === alpha.height &&
      color.frameCount === alpha.frameCount &&
      Math.abs(color.fpsNumerator / color.fpsDenominator - alpha.fpsNumerator / alpha.fpsDenominator) <
        1e-7 &&
      Math.abs(color.duration - alpha.duration) < 0.001,
    'RGB and matte must share dimensions, frame count and clock',
  );
  const colorClock = String(color.raw.streams[0].avg_frame_rate),
    alphaClock = String(alpha.raw.streams[0].avg_frame_rate);
  ensure(
    colorClock === String(color.raw.streams[0].r_frame_rate) &&
      alphaClock === String(alpha.raw.streams[0].r_frame_rate),
    'Normalize variable-rate sources first',
  );
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  const staged = out + '.' + crypto.randomUUID() + '.staged.mp4';
  try {
    await command('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-protocol_whitelist',
      'file,pipe',
      '-noautorotate',
      '-i',
      rgb,
      '-protocol_whitelist',
      'file,pipe',
      '-noautorotate',
      '-i',
      matte,
      '-filter_complex',
      '[0:v]setpts=PTS-STARTPTS,format=rgb24[c];[1:v]setpts=PTS-STARTPTS,format=gray,format=rgb24[a];[c][a]hstack=inputs=2[v]',
      '-map',
      '[v]',
      '-an',
      '-c:v',
      'libx264',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-bf',
      '0',
      '-movflags',
      '+faststart',
      staged,
    ]);
    const actual = await probe(staged);
    ensure(
      actual.width === color.width * 2 &&
        actual.height === color.height &&
        actual.frameCount === color.frameCount,
      'Packed export changed the contract',
    );
    await decodeCheck(staged);
    await fs.copyFile(staged, out, 1); // COPYFILE_EXCL: concurrent writers cannot replace a prior export.
    const record = {
      profile: 'packed-rgb-alpha',
      layout: 'RGB left / grayscale alpha right',
      alphaEncoding: 'straight source, premultiplied output in shader',
      rgbSha256: await hashFile(rgb),
      matteSha256: await hashFile(matte),
      outputSha256: await hashFile(out),
      actual,
      approvalStatus: 'pending',
      note: 'Packing does not segment a person or approve matte quality.',
    };
    await writeJson(out + '.packing.json', record);
    return record;
  } finally {
    await fs.unlink(staged).catch((error: any) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
