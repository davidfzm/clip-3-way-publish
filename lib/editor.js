const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { probe, MAX_SIZE, publicMedia } = require('./media');

// Ratios measured from the supplied 2558 × 1445 Gameplay 2.0 screenshot.
const DEFAULT_TEMPLATE = { camera: { x: 0.816, y: 0.057, w: 0.184, h: 0.289 },
  game: { x: 0.27, y: 0.08, w: 0.48, h: 0.80 }, cameraHeight: 0.25, cameraPlacement: 'top',
  overlay: { x: 0.04, y: 0.04, w: 0.38, h: 0.22 }, subtitleY: 0.76, fontSize: 64, color: 'white' };
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}: valor fuera de rango.`);
  return value;
}
function validateTemplate(value) {
  if (!value || typeof value !== 'object') throw new Error('Plantilla no válida.');
  const crop = (box, label) => {
    if (!box) throw new Error(`Selecciona el recorte de ${label}.`);
    const result = { x: number(box.x, 0, 0.99, label), y: number(box.y, 0, 0.99, label), w: number(box.w, 0.02, 1, label), h: number(box.h, 0.02, 1, label) };
    if (result.x + result.w > 1.00001 || result.y + result.h > 1.00001) throw new Error(`El recorte de ${label} sale del vídeo.`);
    return result;
  };
  if (!['white', 'yellow'].includes(value.color)) throw new Error('Color de subtítulos no válido.');
  if (!['top', 'bottom', 'overlay'].includes(value.cameraPlacement || 'top')) throw new Error('Posición de cámara no válida.');
  return { camera: crop(value.camera, 'cámara'), game: crop(value.game, 'gameplay'),
    cameraPlacement: value.cameraPlacement || 'top', overlay: crop(value.overlay || DEFAULT_TEMPLATE.overlay, 'cámara superpuesta'),
    cameraHeight: number(value.cameraHeight, 0.15, 0.4, 'Altura de cámara'), subtitleY: number(value.subtitleY, 0.35, 0.85, 'Posición de subtítulos'),
    fontSize: number(value.fontSize, 36, 88, 'Tamaño de subtítulos'), color: value.color };
}
function validateClip(entry, input) {
  const start = number(input.start, 0, Math.max(0, entry.duration - 0.1), 'Inicio');
  const end = number(input.end, start + 0.1, entry.duration + 0.05, 'Fin');
  if (end - start > 180.05) throw new Error('Selecciona un fragmento de hasta 180 segundos.');
  return { start, end: Math.min(end, entry.duration) };
}
function validateSegments(segments, duration) {
  if (!Array.isArray(segments) || segments.length > 600) throw new Error('Subtítulos no válidos.');
  let previousEnd = 0;
  return segments.map(cue => {
    const start = number(cue.start, 0, duration, 'Inicio de subtítulo');
    const end = number(cue.end, start + 0.01, duration + 0.1, 'Fin de subtítulo');
    if (start < previousEnd - 0.01) throw new Error('Los subtítulos no pueden solaparse ni estar desordenados.');
    previousEnd = end;
    if (typeof cue.text !== 'string' || cue.text.length > 300) throw new Error('Cada subtítulo admite hasta 300 caracteres.');
    return { start, end: Math.min(end, duration), text: cue.text.trim() };
  });
}
function assTime(seconds) {
  const value = Math.round(seconds * 100);
  return `${Math.floor(value / 360000)}:${String(Math.floor(value / 6000) % 60).padStart(2, '0')}:${String(Math.floor(value / 100) % 60).padStart(2, '0')}.${String(value % 100).padStart(2, '0')}`;
}
function assText(value) {
  // User text must never become ASS positioning/drawing commands.
  return value.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/[\r\n]+/g, '\\N').replace(/[\u0000-\u001f]/g, ' ');
}
function makeAss(segments, template) {
  const color = template.color === 'yellow' ? '&H0000FFFF' : '&H00FFFFFF';
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,${template.fontSize},${color},${color},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,5,80,80,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`
    + segments.filter(cue => cue.text).map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,{\\pos(540,${Math.round(template.subtitleY * 1920)})}${assText(cue.text)}`).join('\n') + '\n';
}
function makeSrt(segments) {
  const time = seconds => { const value = Math.round(seconds * 1000); return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')},${String(value % 1000).padStart(3, '0')}`; };
  return segments.filter(cue => cue.text).map((cue, index) => `${index + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${cue.text}\n`).join('\n');
}
function cropPixels(box, width, height) {
  const even = n => Math.floor(n / 2) * 2;
  const x = even(box.x * width), y = even(box.y * height);
  return { x, y, w: Math.max(2, Math.min(even(box.w * width), even(width - x))), h: Math.max(2, Math.min(even(box.h * height), even(height - y))) };
}
function buildFilter(entry, template, withSubtitles) {
  const camera = cropPixels(template.camera, entry.width, entry.height), game = cropPixels(template.game, entry.width, entry.height);
  const top = Math.round(1920 * template.cameraHeight / 2) * 2;
  const box = (name, crop, height) => `[${name}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1080:${height}:force_original_aspect_ratio=increase,crop=1080:${height},setsar=1[${name}out]`;
  let composition;
  if (template.cameraPlacement === 'overlay') {
    const overlay = cropPixels(template.overlay, 1080, 1920);
    composition = `${box('game', game, 1920)};[camera]crop=${camera.w}:${camera.h}:${camera.x}:${camera.y},scale=${overlay.w}:${overlay.h}:force_original_aspect_ratio=increase,crop=${overlay.w}:${overlay.h},setsar=1[cameraout];[gameout][cameraout]overlay=${overlay.x}:${overlay.y}:shortest=1`;
  } else composition = `${box('camera', camera, top)};${box('game', game, 1920 - top)};${template.cameraPlacement === 'bottom' ? '[gameout][cameraout]' : '[cameraout][gameout]'}vstack=inputs=2`;
  return `[0:v:0]split=2[camera][game];${composition}${withSubtitles ? ',ass=captions.ass' : ''},format=yuv420p[out]`;
}
function execute(binary, args, { cwd, signal, onLine = () => {}, timeout = 30 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', buffer = '', stderr = '';
    const abort = () => child.kill();
    const timer = setTimeout(() => { child.kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-2000000); buffer += chunk;
      let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); onLine(line); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Falta el motor local. Ejecuta npm run setup:subtitles para preparar los subtítulos.')); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Proceso cancelado.'));
      else if (code !== 0) reject(new Error(binary.endsWith('python.exe') || binary.endsWith('python') ? 'No se pudo transcribir. Comprueba npm run setup:subtitles y la pista de audio.' : 'No se pudo generar el vídeo. Comprueba los recortes y el formato del archivo.'));
      else resolve(stdout);
    });
    if (signal?.aborted) abort();
  });
}
function createEditor(media, directory) {
  const tasks = new Map();
  const workRoot = path.join(directory, 'editing'); fs.mkdirSync(workRoot, { recursive: true });
  const python = process.env.SUBTITLE_PYTHON || path.join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = path.join(__dirname, '..', 'scripts', 'transcribe.py');
  const modelDir = process.env.SUBTITLE_MODEL_DIR || path.join(__dirname, '..', '.data', 'models', 'base');
  const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
  let active = null;
  function status() { return { installed: fs.existsSync(python), modelReady: fs.existsSync(path.join(modelDir, 'model.bin')), template: DEFAULT_TEMPLATE }; }
  function start(kind, input) {
    if (active) throw new Error('Ya hay una edición en curso. Espera o cancélala.');
    const entry = media.entries.get(input.mediaId);
    if (!entry || !entry.mime.startsWith('video/')) throw new Error('Vuelve a cargar el vídeo original.');
    const clip = validateClip(entry, input);
    const audioTrack = input.audioTrack === undefined ? 0 : number(input.audioTrack, 0, Math.max(0, entry.audioTracks - 1), 'Pista de audio');
    if (!Number.isInteger(audioTrack)) throw new Error('Selecciona una pista de audio válida.');
    if (kind === 'transcribe' && !entry.hasAudio) throw new Error('Este vídeo no contiene audio. Puedes generar el vertical sin subtítulos.');
    if (kind === 'transcribe' && (!status().installed || !status().modelReady)) throw new Error('Prepara los subtítulos locales con npm run setup:subtitles.');
    if (kind === 'transcribe' && !['es', 'en', 'auto'].includes(input.language)) throw new Error('Idioma no válido.');
    const template = kind === 'render' ? validateTemplate(input.template) : null;
    if (kind === 'render' && typeof input.subtitles !== 'boolean') throw new Error('Indica si quieres subtítulos.');
    const segments = kind === 'render' && input.subtitles ? validateSegments(input.segments, clip.end - clip.start) : [];
    if (kind === 'render' && input.subtitles && !segments.some(cue => cue.text)) throw new Error('Genera y revisa los subtítulos, o desactívalos.');
    if (media.entries.size >= 20) throw new Error('Límite de archivos temporales alcanzado.');
    const task = { id: crypto.randomUUID(), kind, status: 'running', progress: 0, message: 'Preparando archivo', createdAt: Date.now() };
    const controller = new AbortController(); active = { task, controller }; tasks.set(task.id, task);
    const working = path.join(workRoot, task.id); fs.mkdirSync(working);
    const update = value => Object.assign(task, value);
    void (async () => {
      let output;
      try {
        if (kind === 'transcribe') {
          const audio = path.join(working, 'speech.wav');
          await execute(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-ss', String(clip.start), '-i', entry.file, '-t', String(clip.end - clip.start), '-map', `0:a:${audioTrack}`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio], { signal: controller.signal });
          let result;
          await execute(python, [script, '--model-dir', modelDir, '--audio', audio, '--language', input.language], { signal: controller.signal, onLine(line) {
            try { const event = JSON.parse(line); if (event.progress !== undefined) update({ progress: event.progress, message: event.message }); if (event.result) result = event.result; } catch {}
          } });
          if (!result) throw new Error('No se recibió una transcripción válida.');
          // Round/clip model timestamps to the requested clip; silence remains empty.
          let previousEnd = 0;
          result.segments = result.segments.map(cue => {
            const start = Math.max(previousEnd, 0, cue.start), end = Math.min(clip.end - clip.start, cue.end);
            previousEnd = Math.max(previousEnd, end); return { start, end, text: cue.text };
          }).filter(cue => cue.end - cue.start >= 0.01);
          update({ result: { ...result, sourceId: entry.id, start: clip.start, end: clip.end, audioTrack }, status: 'done', progress: 100,
            message: result.segments.length ? 'Subtítulos generados. Revisa el texto.' : 'No se ha detectado voz. Puedes generar el vertical sin subtítulos.' });
        } else {
          if (segments.length) fs.writeFileSync(path.join(working, 'captions.ass'), makeAss(segments, template), 'utf8');
          const id = crypto.randomUUID(); output = path.join(directory, 'uploads', id + '.mp4');
          const duration = clip.end - clip.start;
          await execute(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-protocol_whitelist', 'file,pipe', '-ss', String(clip.start), '-i', entry.file,
            '-t', String(duration), '-filter_complex', buildFilter(entry, template, !!segments.length), '-map', '[out]', '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', output],
          { cwd: working, signal: controller.signal, onLine(line) { if (line.startsWith('out_time_us=')) update({ progress: Math.min(99, Math.round(Number(line.split('=')[1]) / 1000000 / duration * 100)), message: 'Generando MP4 vertical' }); } });
          const size = fs.statSync(output).size;
          if (size > MAX_SIZE) throw new Error('El vertical supera los 500 MB. Acorta el fragmento.');
          const result = { id, file: output, size, mime: 'video/mp4', ...await probe(output), createdAt: Date.now() };
          media.entries.set(id, result);
          update({ result: { media: publicMedia(result), srt: makeSrt(segments) }, status: 'done', progress: 100, message: 'Vertical listo para revisar y compartir.' });
        }
      } catch (error) {
        if (output) await fs.promises.rm(output, { force: true });
        update({ status: controller.signal.aborted ? 'cancelled' : 'error', message: error.message });
      } finally {
        // This path is created from a UUID under this task's own workspace only.
        const resolved = path.resolve(working);
        if (resolved.startsWith(path.resolve(workRoot) + path.sep)) await fs.promises.rm(resolved, { recursive: true, force: true });
        active = null;
        for (const [id, past] of tasks) if (id !== task.id && Date.now() - past.createdAt > 3600000) tasks.delete(id);
      }
    })();
    return task;
  }
  return { status, start, tasks, cancel(id) { if (active?.task.id === id) active.controller.abort(); }, close() { active?.controller.abort(); } };
}
module.exports = { createEditor, DEFAULT_TEMPLATE, validateTemplate, validateClip, validateSegments, makeAss, makeSrt, buildFilter, cropPixels };
