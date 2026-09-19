import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { command, packAlpha, trimVideo } from '../src/authoring/media';
import { mp4Info } from '../src/main/mp4';
test('packed-alpha tooling retains one clock and rejects a mismatched matte', async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('test-results/alpha-'));
  try {
    const source = path.resolve('content/engineering-graph/0.1.0/media/video/E00.mp4'),
      rgb = path.join(dir, 'rgb.mp4'),
      matte = path.join(dir, 'matte.mp4');
    for (const [file, x] of [
      [rgb, '0'],
      [matte, 'iw/2'],
    ])
      await command('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-i',
        source,
        '-vf',
        `crop=iw/2:ih:${x}:0`,
        '-an',
        '-c:v',
        'libx264',
        '-bf',
        '0',
        file,
      ]);
    const out = path.join(dir, 'packed.mp4'),
      record = await packAlpha(rgb, matte, out);
    const actual = mp4Info(await fs.readFile(out));
    assert.equal(actual.width, 640);
    assert.equal(actual.height, 180);
    assert.equal(actual.frameCount, 30);
    assert.equal(record.approvalStatus, 'pending');
    const short = path.join(dir, 'short.mp4');
    await trimVideo(matte, 0, 20, short, '30/1');
    await assert.rejects(packAlpha(rgb, short, path.join(dir, 'bad.mp4')), /clock/);
    await assert.rejects(packAlpha(rgb, matte, out), /exists/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
