const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const MAX_SIZE = 500 * 1024 * 1024;

function run(binary, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('La conversión ha superado el tiempo máximo.')); }, timeout);
    child.stdout.on('data', value => { out = (out + value).slice(-1000000); });
    child.stderr.on('data', value => { err = (err + value).slice(-8000); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('No se encuentra FFmpeg/FFprobe. Ejecuta npm install.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('No se pudo leer o convertir el vídeo. Comprueba que el archivo no esté dañado.'));
      else resolve(out);
    });
  });
}
async function probe(file) {
  const result = JSON.parse(await run(process.env.FFPROBE_PATH || require('ffprobe-static').path,
    ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = result.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video || !Number.isFinite(Number(result.format.duration)) || Number(result.format.duration) <= 0) throw new Error('El archivo no contiene un vídeo válido con duración conocida.');
  const audio = result.streams.filter(stream => stream.codec_type === 'audio');
  return { duration: Number(result.format.duration), width: video.width, height: video.height, videoCodec: video.codec_name,
    audioCodec: audio[0]?.codec_name || null, audioTracks: audio.length, hasAudio: audio.length > 0,
    audioTrackInfo: audio.map((stream, index) => ({ index, label: stream.tags?.title || `Pista ${index + 1}`, codec: stream.codec_name })) };
}
function createMedia(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const entries = new Map();
  let converting = false;
  async function receive(request) {
    const mime = (request.headers['content-type'] || '').split(';')[0];
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) throw new Error('Formato no admitido. Usa MP4, MOV o WebM.');
    if (Number(request.headers['content-length']) > MAX_SIZE) throw new Error('El vídeo supera los 500 MB.');
    const id = crypto.randomUUID();
    const file = path.join(directory, id + ({ 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' }[mime]));
    let size = 0;
    try {
      await pipeline(request, new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > MAX_SIZE ? new Error('El vídeo supera los 500 MB.') : null, chunk);
      } }), fs.createWriteStream(file, { flags: 'wx' }));
      if (!size) throw new Error('El archivo está vacío.');
      const metadata = await probe(file);
      const entry = { id, file, mime, size, ...metadata, createdAt: Date.now() };
      entries.set(id, entry);
      return entry;
    } catch (error) { await fs.promises.rm(file, { force: true }); throw error; }
  }
  async function convert(entry) {
    if (converting) throw new Error('Ya hay un vídeo convirtiéndose. Espera a que termine.');
    converting = true;
    const id = crypto.randomUUID();
    const file = path.join(directory, id + '.mp4');
    try {
      await run(process.env.FFMPEG_PATH || require('ffmpeg-static'), ['-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', entry.file,
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', file], 30 * 60000);
      const size = fs.statSync(file).size;
      if (size > MAX_SIZE) throw new Error('El vídeo convertido supera los 500 MB.');
      const converted = { id, file, mime: 'video/mp4', size, ...await probe(file), createdAt: Date.now() };
      entries.set(id, converted);
      return converted;
    } catch (error) { await fs.promises.rm(file, { force: true }); throw error; }
    finally { converting = false; }
  }
  return { entries, receive, convert };
}
function publicMedia(entry) {
  const { file, ...safe } = entry;
  return { ...safe, url: `/api/media/${entry.id}` };
}
function serveMedia(request, response, entry) {
  const range = request.headers.range;
  let start = 0, end = entry.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${entry.size}` }); response.end(); return; }
    if (!match[1]) start = Math.max(0, entry.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= entry.size) { response.writeHead(416, { 'Content-Range': `bytes */${entry.size}` }); response.end(); return; }
  }
  response.writeHead(range ? 206 : 200, { 'Content-Type': entry.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : {}) });
  if (request.method === 'HEAD') return response.end();
  const stream = fs.createReadStream(entry.file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
module.exports = { createMedia, publicMedia, serveMedia, probe, run, MAX_SIZE };
