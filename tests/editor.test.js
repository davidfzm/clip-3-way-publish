const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMedia, probe, run } = require('../lib/media');
const { createEditor, DEFAULT_TEMPLATE, validateTemplate, validateSegments, validateClip, makeAss } = require('../lib/editor');

test('Editor rejects invalid crops, unsafe ranges and overlapping subtitles', () => {
  assert.throws(() => validateTemplate({ ...DEFAULT_TEMPLATE, camera: { x: 0.9, y: 0, w: 0.3, h: 0.5 } }), /sale/);
  assert.throws(() => validateTemplate({ ...DEFAULT_TEMPLATE, cameraHeight: NaN }), /rango/);
  assert.throws(() => validateClip({ duration: 300 }, { start: 0, end: 181 }), /180/);
  assert.throws(() => validateSegments([{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }], 4), /solaparse/);
  const ass = makeAss([{ start: 0, end: 1, text: '{\\pos(0,0)}hola\nmundo' }], DEFAULT_TEMPLATE);
  assert.ok(!ass.includes('{\\pos(0,0)}'));
  assert.ok(ass.includes('hola\\Nmundo'));
});

test('Vertical rendering creates native 1080×1920 MP4, camera positions, trimmed audio and burned captions', async t => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data-'));
  const uploads = path.join(directory, 'uploads');
  const media = createMedia(uploads), editor = createEditor(media, directory);
  const ffmpeg = require('ffmpeg-static');
  async function finish(task) {
    const deadline = Date.now() + 60000;
    while (task.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(task.status, 'done', task.message); return task.result;
  }
  function pixel(file, x, y) {
    return execFileSync(ffmpeg, ['-v', 'error', '-ss', '0.4', '-i', file, '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true }).subarray(0, 3);
  }
  function isRed(value) { assert.ok(value[0] > 180 && value[2] < 70, `Expected camera red, got ${value}`); }
  function isBlue(value) { assert.ok(value[2] > 180 && value[0] < 70, `Expected gameplay blue, got ${value}`); }
  try {
    const fixture = path.join(directory, 'source.mp4');
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-vf', 'drawbox=x=iw*0.816:y=ih*0.057:w=iw*0.184:h=ih*0.289:color=red:t=fill', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', fixture]);
    const entry = { id: 'source', file: fixture, mime: 'video/mp4', size: fs.statSync(fixture).size, ...await probe(fixture) }; media.entries.set(entry.id, entry);
    const common = { mediaId: entry.id, start: 0.5, end: 2.5, subtitles: false, template: DEFAULT_TEMPLATE };
    await t.test('Camera above gameplay and duration match selected interval', async () => {
      const result = await finish(editor.start('render', common));
      assert.equal(result.media.width, 1080); assert.equal(result.media.height, 1920); assert.equal(result.media.audioCodec, 'aac');
      assert.ok(Math.abs(result.media.duration - 2) < 0.15);
      const file = media.entries.get(result.media.id).file; isRed(pixel(file, 540, 200)); isBlue(pixel(file, 540, 1000));
    });
    await t.test('Camera below gameplay', async () => {
      const result = await finish(editor.start('render', { ...common, template: { ...DEFAULT_TEMPLATE, cameraPlacement: 'bottom' } }));
      const file = media.entries.get(result.media.id).file; isBlue(pixel(file, 540, 300)); isRed(pixel(file, 540, 1700));
    });
    await t.test('Movable camera overlay and real subtitle pixels', async () => {
      const result = await finish(editor.start('render', { ...common, template: { ...DEFAULT_TEMPLATE, cameraPlacement: 'overlay' }, subtitles: true,
        segments: [{ start: 0, end: 1.5, text: 'PRUEBA DE SUBTÍTULOS' }] }));
      const file = media.entries.get(result.media.id).file; isRed(pixel(file, 150, 180)); isBlue(pixel(file, 800, 800));
      const region = execFileSync(ffmpeg, ['-v', 'error', '-ss', '0.4', '-i', file, '-vf', 'crop=1000:160:40:1380,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, maxBuffer: 1000000 });
      let white = 0; for (let i = 0; i < region.length; i += 3) if (region[i] > 200 && region[i + 1] > 200 && region[i + 2] > 200) white++;
      assert.ok(white > 300, 'Subtitles must be burned into the actual MP4');
      assert.match(result.srt, /00:00:00,000 --> 00:00:01,500/);
      assert.ok(result.srt.includes('PRUEBA DE SUBTÍTULOS'));
    });
    await t.test('A cancelled task leaves the original and no partial media result', async () => {
      const count = media.entries.size; const task = editor.start('render', common); editor.cancel(task.id);
      while (task.status === 'running') await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(task.status, 'cancelled'); assert.equal(media.entries.size, count); assert.ok(fs.existsSync(fixture));
    });
  } finally {
    editor.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep + '.test-data-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
