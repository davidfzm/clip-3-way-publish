const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./lib/store');
const { createMedia, publicMedia, serveMedia } = require('./lib/media');
const { createProviders, NAMES } = require('./lib/providers');
const { createEditor } = require('./lib/editor');
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
files['/vertical.js'] = ['vertical.js', 'text/javascript'];
files['/vertical.css'] = ['vertical.css', 'text/css'];

function createApp({ directory = process.env.DATA_DIR || path.join(__dirname, '.data'), port = Number(process.env.PORT) || 3010, providersFactory = createProviders } = {}) {
  directory = path.resolve(directory);
  const store = createStore(directory);
  const uploadsDirectory = path.join(directory, 'uploads');
  fs.mkdirSync(uploadsDirectory, { recursive: true });
  // Only expired generated files, never user-selected originals or files from a recent session.
  for (const name of fs.readdirSync(uploadsDirectory)) {
    const file = path.join(uploadsDirectory, name);
    if (/^[a-f0-9-]{36}\.(mp4|mov|webm|wav)$/.test(name) && Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.unlinkSync(file);
  }
  const media = createMedia(uploadsDirectory);
  const editor = createEditor(media, directory);
  const providers = providersFactory(store);
  const sessions = new Map(), states = new Map(), tickets = new Map(), publicLinks = new Map(), checking = new Set();
  const jobsFile = path.join(directory, 'jobs.json');
  const jobs = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : {};
  for (const job of Object.values(jobs)) for (const item of Object.values(job.results)) {
    if (['queued', 'uploading', 'processing'].includes(item.status)) Object.assign(item, { status: 'uncertain', message: 'El servidor se reinició. Comprueba el estado antes de repetir la publicación.' });
  }
  function saveJobs() { fs.writeFileSync(jobsFile + '.tmp', JSON.stringify(jobs, null, 2), { mode: 0o600 }); fs.renameSync(jobsFile + '.tmp', jobsFile); }
  function localOrigin(request) { return `http://${request.headers.host}`; }
  function isLocal(request) { const activePort = server.address()?.port || port; return [`localhost:${activePort}`, `127.0.0.1:${activePort}`].includes(request.headers.host) && !request.headers['x-forwarded-for'] && !request.headers['forwarded'] && !request.headers['x-forwarded-host']; }
  function sessionFor(request) {
    const sid = /(?:^|;\s*)clip_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const session = sessions.get(sid);
    return session && session.expires > Date.now() ? { ...session, id: sid } : null;
  }
  function send(response, code, data) { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
  async function body(request, limit = 24000) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Se esperaba JSON.');
    let text = '';
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > limit) throw new Error('Solicitud demasiado grande.'); }
    try { return JSON.parse(text); } catch { throw new Error('JSON no válido.'); }
  }
  function cleanConfig(id) {
    const entry = store.data.providers[id] || {};
    return { name: NAMES[id], configured: !!(entry.clientId && entry.clientSecret && entry.redirectUri), clientId: entry.clientId || '',
      hasSecret: !!entry.clientSecret, redirectUri: entry.redirectUri || `http://localhost:${port}/oauth/${id}/callback`,
      connected: !!entry.token, account: entry.account || null, tiktokMode: entry.tiktokMode || 'inbox', tiktokLogin: entry.tiktokLogin || 'desktop',
      graphVersion: entry.graphVersion || 'v24.0' };
  }
  function validateConfig(id, value) {
    if (!Object.hasOwn(NAMES, id)) throw new Error('Plataforma desconocida.');
    const old = store.data.providers[id] || {};
    if (typeof value.clientId !== 'string' || !value.clientId.trim() || value.clientId.length > 500) throw new Error('Introduce el identificador de la aplicación.');
    if (typeof value.clientSecret !== 'string' || value.clientSecret.length > 2000 || (!value.clientSecret && !old.clientSecret)) throw new Error('Introduce el secreto de la aplicación.');
    let redirect;
    try { redirect = new URL(value.redirectUri); } catch { throw new Error('URL de retorno no válida.'); }
    const isLoopback = ['localhost', '127.0.0.1'].includes(redirect.hostname);
    if (redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== `/oauth/${id}/callback` || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && isLoopback))) throw new Error(`La URL de retorno debe usar HTTPS y terminar en /oauth/${id}/callback. Solo localhost permite HTTP.`);
    if (isLoopback && redirect.port !== String(port)) throw new Error(`Usa el puerto ${port} en la URL de retorno.`);
    if (id === 'instagram' && redirect.protocol !== 'https:') throw new Error('Instagram necesita una URL de retorno HTTPS pública.');
    if (id === 'tiktok') {
      if (!['inbox', 'direct'].includes(value.tiktokMode) || !['desktop', 'web'].includes(value.tiktokLogin)) throw new Error('Selecciona el modo de TikTok.');
      if (value.tiktokLogin === 'desktop' && !isLoopback) throw new Error('Login Kit Desktop requiere localhost o 127.0.0.1.');
      if (value.tiktokLogin === 'web' && redirect.protocol !== 'https:') throw new Error('Login Kit Web requiere una URL HTTPS.');
    }
    if (id === 'instagram' && !/^v\d{2}\.0$/.test(value.graphVersion || '')) throw new Error('Versión de Graph API no válida (por ejemplo, v24.0).');
    const entry = { clientId: value.clientId.trim(), clientSecret: value.clientSecret || old.clientSecret, redirectUri: redirect.href,
      tiktokMode: value.tiktokMode || 'inbox', tiktokLogin: value.tiktokLogin || 'desktop', graphVersion: value.graphVersion || 'v24.0' };
    const same = Object.keys(entry).every(key => entry[key] === old[key]);
    if (same) Object.assign(entry, { token: old.token, account: old.account });
    return entry;
  }
  function validatePost(input) {
    if (!input || typeof input.title !== 'string' || typeof input.description !== 'string' || input.title.length > 100 || input.description.length > 2200) throw new Error('Título o descripción no válidos.');
    if (!Array.isArray(input.platforms) || !input.platforms.length || new Set(input.platforms).size !== input.platforms.length || input.platforms.some(id => !Object.hasOwn(NAMES, id))) throw new Error('Selecciona las redes de destino.');
    const entry = media.entries.get(input.mediaId);
    if (!entry || !entry.mime.startsWith('video/')) throw new Error('Vuelve a seleccionar el vídeo; ya no está disponible en el servidor.');
    if (!/^[a-f0-9-]{36}$/.test(input.requestId || '')) throw new Error('Identificador de publicación no válido.');
    for (const id of input.platforms) if (!store.data.providers[id]?.token) throw new Error(`Conecta tu cuenta de ${NAMES[id]}.`);
    if (input.platforms.includes('youtube')) {
      if (!input.title.trim() || /[<>]/.test(input.title)) throw new Error('YouTube necesita un título sin los caracteres < y >.');
      if (Buffer.byteLength(input.description, 'utf8') > 5000 || /[<>]/.test(input.description)) throw new Error('La descripción de YouTube no puede superar 5.000 bytes UTF-8 ni contener < o >.');
      if (!['private', 'unlisted', 'public'].includes(input.youtubePrivacy) || !['yes', 'no'].includes(input.madeForKids)) throw new Error('Selecciona la visibilidad y el público de YouTube.');
      if (entry.duration > 180 || entry.width > entry.height) throw new Error('Para Shorts, selecciona un vídeo vertical o cuadrado de hasta 3 minutos.');
    }
    if (input.platforms.includes('tiktok') && store.data.providers.tiktok.tiktokMode === 'direct' && (!input.tiktokPrivacy || input.tiktokConsent !== true)) throw new Error('Selecciona la privacidad y acepta la confirmación de TikTok.');
    if (input.platforms.includes('instagram')) {
      if (!store.data.publicOrigin) throw new Error('Configura la URL HTTPS pública para que Instagram pueda descargar el vídeo.');
      if (!['video/mp4', 'video/quicktime'].includes(entry.mime) || !['h264', 'hevc'].includes(entry.videoCodec) || (entry.hasAudio && entry.audioCodec !== 'aac')) throw new Error('Convierte el vídeo a MP4 compatible antes de enviarlo a Instagram.');
      if (entry.duration < 3 || entry.duration > 900) throw new Error('Instagram Reels requiere un vídeo de entre 3 segundos y 15 minutos.');
    }
    return entry;
  }
  async function checkJob(job) {
    if (checking.has(job.id)) return;
    checking.add(job.id);
    try {
      await Promise.all(Object.entries(job.results).filter(([, item]) => ['processing', 'uncertain'].includes(item.status) && item.remoteId).map(async ([id, item]) => {
        const update = value => { Object.assign(item, value); saveJobs(); };
        try {
          if (item.accountId && store.data.providers[id]?.account?.id !== item.accountId) throw new Error('Vuelve a conectar la cuenta original de esta publicación para consultar su estado.');
          await providers.check(id, item, update);
        }
        catch (error) { update({ status: 'uncertain', message: error.message }); }
      }));
    } finally { checking.delete(job.id); }
  }
  async function startJob(job, entry, input) {
    await Promise.all(input.platforms.map(async id => {
      const update = value => { Object.assign(job.results[id], value); saveJobs(); };
      let publicUrl;
      if (id === 'instagram') {
        const token = crypto.randomBytes(32).toString('hex');
        publicLinks.set(token, { mediaId: entry.id, expires: Date.now() + 3600000 });
        publicUrl = `${store.data.publicOrigin}/media/${token}`;
      }
      try { await providers.publish(id, entry, input, update, publicUrl); }
      catch (error) { update({ status: job.results[id].remoteId ? 'uncertain' : 'error', message: error.message }); }
    }));
    await checkJob(job);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      let match;
      if (['GET', 'HEAD'].includes(request.method) && (match = /^\/media\/([a-f0-9]{64})$/.exec(url.pathname))) {
        const link = publicLinks.get(match[1]), entry = link && media.entries.get(link.mediaId);
        if (!entry || link.expires < Date.now()) return send(response, 404, { error: 'Archivo no disponible.' });
        return serveMedia(request, response, entry);
      }
      if (request.method === 'GET' && (match = /^\/oauth\/(tiktok|youtube|instagram)\/callback$/.exec(url.pathname))) {
        const state = url.searchParams.get('state'), pending = states.get(state);
        if (!pending || pending.id !== match[1] || pending.expires < Date.now()) return send(response, 400, { error: 'La autorización ha caducado o no es válida. Iníciala de nuevo desde 3wayClip.' });
        states.delete(state);
        const ticket = crypto.randomBytes(32).toString('hex');
        tickets.set(ticket, { ...pending, code: url.searchParams.get('code'), denied: url.searchParams.has('error') });
        response.writeHead(302, { Location: `${pending.origin}/oauth/finish?ticket=${ticket}` }); response.end(); return;
      }
      if (!isLocal(request)) return send(response, 403, { error: 'La administración solo está disponible desde localhost. El acceso público se limita a OAuth y vídeos autorizados.' });
      let session = sessionFor(request);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        if (request.headers['sec-fetch-site'] === 'cross-site') return send(response, 403, { error: 'Origen no permitido.' });
        if (!session) {
          const id = crypto.randomBytes(32).toString('hex');
          session = { id, csrf: crypto.randomBytes(32).toString('hex'), expires: Date.now() + 86400000 };
          sessions.set(id, session);
          response.setHeader('Set-Cookie', `clip_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
        }
        return send(response, 200, { csrf: session.csrf, providers: Object.fromEntries(Object.keys(NAMES).map(id => [id, cleanConfig(id)])), publicOrigin: store.data.publicOrigin || '', jobs: Object.values(jobs).slice(-20) });
      }
      if (request.method === 'GET' && url.pathname === '/oauth/finish') {
        const ticket = url.searchParams.get('ticket'), pending = tickets.get(ticket);
        if (!session || !pending || pending.sessionId !== session.id || pending.expires < Date.now()) return send(response, 403, { error: 'Abre la autorización en el navegador donde iniciaste la conexión.' });
        tickets.delete(ticket);
        let result;
        try {
          if (pending.denied || !pending.code) throw new Error('Autorización cancelada o denegada.');
          if (pending.configSignature !== JSON.stringify(store.data.providers[pending.id])) throw new Error('La configuración cambió durante el inicio de sesión. Vuelve a conectar.');
          await providers.exchange(pending.id, pending.code, pending.verifier);
          result = `${NAMES[pending.id]} conectado.`;
        } catch (error) { result = error.message; }
        response.writeHead(302, { Location: '/?connection=' + encodeURIComponent(result) }); response.end(); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) return send(response, 401, { error: 'Recarga la página para iniciar una sesión local.' });
        if (!['GET', 'HEAD'].includes(request.method) && (request.headers.origin !== localOrigin(request) || request.headers['x-csrf-token'] !== session.csrf)) return send(response, 403, { error: 'Solicitud no autorizada.' });
        if (request.method === 'GET' && url.pathname === '/api/editor/status') return send(response, 200, editor.status());
        if (request.method === 'POST' && (match = /^\/api\/editor\/(transcribe|render)$/.exec(url.pathname))) {
          return send(response, 202, editor.start(match[1], await body(request, 256000)));
        }
        if (request.method === 'GET' && (match = /^\/api\/editor\/tasks\/([a-f0-9-]{36})$/.exec(url.pathname))) {
          const task = editor.tasks.get(match[1]); return send(response, task ? 200 : 404, task || { error: 'La edición ya no está disponible. Vuelve a cargar el vídeo.' });
        }
        if (request.method === 'POST' && (match = /^\/api\/editor\/tasks\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname))) {
          editor.cancel(match[1]); return send(response, 200, { ok: true });
        }
        if (request.method === 'POST' && (match = /^\/api\/settings\/(tiktok|youtube|instagram)$/.exec(url.pathname))) {
          if (Object.values(jobs).some(job => Object.values(job.results).some(item => ['queued', 'uploading', 'processing'].includes(item.status)))) throw new Error('Espera a que terminen las publicaciones antes de cambiar las cuentas.');
          store.data.providers[match[1]] = validateConfig(match[1], await body(request)); store.save();
          return send(response, 200, { ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/settings/public') {
          const input = await body(request);
          let origin = '';
          if (input.publicOrigin) {
            const parsed = new URL(input.publicOrigin);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || ['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Introduce el origen HTTPS público, sin ruta ni parámetros.');
            origin = parsed.origin;
          }
          store.data.publicOrigin = origin; store.save(); return send(response, 200, { ok: true });
        }
        if (request.method === 'POST' && (match = /^\/api\/connect\/(tiktok|youtube|instagram)$/.exec(url.pathname))) {
          const state = crypto.randomBytes(32).toString('hex'), auth = providers.authorization(match[1], state);
          states.set(state, { id: match[1], sessionId: session.id, origin: localOrigin(request), verifier: auth.verifier, expires: Date.now() + 10 * 60000, configSignature: JSON.stringify(store.data.providers[match[1]]) });
          return send(response, 200, { url: auth.url });
        }
        if (request.method === 'POST' && (match = /^\/api\/disconnect\/(tiktok|youtube|instagram)$/.exec(url.pathname))) {
          if (Object.values(jobs).some(job => ['queued', 'uploading', 'processing'].includes(job.results[match[1]]?.status))) throw new Error('Espera a que termine la publicación antes de desconectar.');
          await providers.disconnect(match[1]); return send(response, 200, { ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/tiktok/creator') return send(response, 200, await providers.creator());
        if (request.method === 'POST' && url.pathname === '/api/uploads') {
          if (media.entries.size >= 20) throw new Error('Límite de 20 archivos por sesión. Reinicia el servidor para iniciar otra sesión; los temporales caducados se limpian al arrancar.');
          return send(response, 201, publicMedia(await media.receive(request)));
        }
        if (request.method === 'POST' && (match = /^\/api\/uploads\/([a-f0-9-]{36})\/convert$/.exec(url.pathname))) {
          if (media.entries.size >= 20) throw new Error('Límite de archivos temporales de esta sesión alcanzado.');
          const entry = media.entries.get(match[1]); if (!entry || !entry.mime.startsWith('video/')) throw new Error('Vuelve a seleccionar el vídeo.');
          return send(response, 200, publicMedia(await media.convert(entry)));
        }
        if (['GET', 'HEAD'].includes(request.method) && (match = /^\/api\/media\/([a-f0-9-]{36})$/.exec(url.pathname))) {
          const entry = media.entries.get(match[1]); if (!entry) return send(response, 404, { error: 'Vídeo no disponible.' });
          return serveMedia(request, response, entry);
        }
        if (request.method === 'POST' && url.pathname === '/api/publish') {
          const input = await body(request);
          if (Object.hasOwn(jobs, input.requestId || '')) return send(response, 200, jobs[input.requestId]);
          if (Object.values(jobs).some(job => Object.values(job.results).some(item => ['queued', 'uploading', 'processing'].includes(item.status)))) throw new Error('Ya hay una publicación en curso.');
          const entry = validatePost(input);
          const job = { id: input.requestId, createdAt: Date.now(), title: input.title, results: Object.fromEntries(input.platforms.map(id => [id, { status: 'queued', message: 'Pendiente', account: store.data.providers[id].account?.name, accountId: store.data.providers[id].account?.id }])) };
          jobs[job.id] = job; saveJobs();
          void startJob(job, entry, input).catch(() => {});
          return send(response, 202, job);
        }
        if (request.method === 'POST' && (match = /^\/api\/jobs\/([a-f0-9-]{36})\/refresh$/.exec(url.pathname))) {
          const job = jobs[match[1]]; if (!job) return send(response, 404, { error: 'Publicación no encontrada.' });
          await checkJob(job); return send(response, 200, job);
        }
        if (request.method === 'GET' && (match = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname))) {
          const job = jobs[match[1]]; return send(response, job ? 200 : 404, job || { error: 'Publicación no encontrada.' });
        }
        return send(response, 404, { error: 'Ruta no encontrada.' });
      }
      if (request.method !== 'GET' || !Object.hasOwn(files, url.pathname)) return send(response, 404, { error: 'No encontrado.' });
      const [file, mime] = files[url.pathname];
      response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); response.end(fs.readFileSync(path.join(__dirname, file)));
    } catch (error) {
      if (!response.headersSent) send(response, 400, { error: error.message || 'No se pudo completar la solicitud.' });
      else response.destroy();
    }
  });
  server.requestTimeout = 35 * 60000;
  const timer = setInterval(() => {
    for (const map of [sessions, states, tickets, publicLinks]) for (const [key, item] of map) if (item.expires < Date.now()) map.delete(key);
    for (const job of Object.values(jobs)) {
      if (Date.now() - job.createdAt > 60 * 60000) {
        for (const item of Object.values(job.results)) if (item.status === 'processing') Object.assign(item, { status: 'uncertain', message: 'La plataforma sigue sin confirmar el resultado. Pulsa Comprobar estados antes de repetir.' });
      } else if (Object.values(job.results).some(item => item.status === 'processing')) void checkJob(job);
    }
  }, 15000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); editor.close(); });
  return { server, store, media, jobs, editor };
}
if (require.main === module) {
  const port = Number(process.env.PORT) || 3010;
  const { server } = createApp({ port });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `El puerto ${port} está ocupado. Cierra la instancia anterior o cambia PORT.` : 'No se pudo iniciar el servidor.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`3wayClip disponible en http://localhost:${port}`));
}
module.exports = { createApp };
