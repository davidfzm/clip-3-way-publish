const fs = require('node:fs');
const crypto = require('node:crypto');
const NAMES = { tiktok: 'TikTok', youtube: 'YouTube Shorts', instagram: 'Instagram Reels' };
const GRAPH = 'https://graph.instagram.com';
const TT = 'https://open.tiktokapis.com/v2';

async function remote(url, options = {}) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error', ...options }); }
  catch { throw new Error('No se pudo contactar con la plataforma. Comprueba la conexión antes de reintentar.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.error && data.error.code !== 'ok')) {
    const code = typeof data.error === 'string' ? data.error : data.error?.code || response.status;
    // Provider messages can contain request URLs/tokens: only expose their error code.
    throw new Error(`La plataforma rechazó la solicitud (${code}). Revisa permisos, credenciales y límites de tu aplicación.`);
  }
  return data;
}
const form = body => ({ method: 'POST', body: new URLSearchParams(body) });
const bearer = token => ({ Authorization: `Bearer ${token}` });
const json = (token, body) => ({ method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const withQuery = (url, values) => `${url}?${new URLSearchParams(values)}`;

function createProviders(store) {
  const locks = new Map();
  function config(id) {
    if (!Object.hasOwn(NAMES, id)) throw new Error('Plataforma desconocida.');
    const entry = store.data.providers[id];
    if (!entry?.clientId || !entry.clientSecret || !entry.redirectUri) throw new Error('Configura primero las credenciales de la aplicación.');
    return entry;
  }
  function scopes(id, entry) {
    if (id === 'youtube') return ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
    if (id === 'instagram') return ['instagram_business_basic', 'instagram_business_content_publish'];
    return ['user.info.basic', entry.tiktokMode === 'inbox' ? 'video.upload' : 'video.publish'];
  }
  function authorization(id, state) {
    const entry = config(id);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = { response_type: 'code', redirect_uri: entry.redirectUri, state };
    let url;
    if (id === 'youtube') {
      url = 'https://accounts.google.com/o/oauth2/v2/auth';
      Object.assign(params, { client_id: entry.clientId, scope: scopes(id, entry).join(' '), access_type: 'offline', prompt: 'consent',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    } else if (id === 'tiktok') {
      url = 'https://www.tiktok.com/v2/auth/authorize/';
      Object.assign(params, { client_key: entry.clientId, scope: scopes(id, entry).join(','), disable_auto_auth: '1' });
      if (entry.tiktokLogin === 'desktop') Object.assign(params, {
        code_challenge: crypto.createHash('sha256').update(verifier).digest('hex'), code_challenge_method: 'S256'
      });
    } else {
      url = 'https://www.instagram.com/oauth/authorize';
      Object.assign(params, { client_id: entry.clientId, scope: scopes(id, entry).join(','), enable_fb_login: '0', force_authentication: '1' });
    }
    return { url: withQuery(url, params), verifier };
  }
  async function exchange(id, code, verifier) {
    const entry = config(id);
    let token;
    if (id === 'youtube') token = await remote('https://oauth2.googleapis.com/token', form({ client_id: entry.clientId, client_secret: entry.clientSecret,
      code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: entry.redirectUri }));
    if (id === 'tiktok') token = await remote(`${TT}/oauth/token/`, form({ client_key: entry.clientId, client_secret: entry.clientSecret,
      code, grant_type: 'authorization_code', redirect_uri: entry.redirectUri, ...(entry.tiktokLogin === 'desktop' ? { code_verifier: verifier } : {}) }));
    if (id === 'instagram') {
      const body = new FormData();
      Object.entries({ client_id: entry.clientId, client_secret: entry.clientSecret, code, grant_type: 'authorization_code', redirect_uri: entry.redirectUri }).forEach(([key, value]) => body.set(key, value));
      const short = await remote('https://api.instagram.com/oauth/access_token', { method: 'POST', body });
      token = await remote(withQuery(`${GRAPH}/access_token`, { grant_type: 'ig_exchange_token', client_secret: entry.clientSecret, access_token: short.access_token }));
      token.user_id = String(short.user_id);
      if (Array.isArray(short.permissions)) token.scope = short.permissions.join(',');
    }
    if (!token?.access_token) throw new Error('La plataforma no devolvió una autorización válida.');
    if (token.scope) {
      const granted = token.scope.split(/[ ,]+/);
      if (scopes(id, entry).some(scope => !granted.includes(scope))) throw new Error('Faltan permisos. Vuelve a conectar y autoriza los permisos de publicación.');
    }
    const previous = entry.token;
    entry.token = { ...token, expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000 };
    try {
      if (id === 'youtube') {
        const info = await remote('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(token.access_token) });
        if (!info.items?.length) throw new Error('La cuenta de Google no tiene un canal de YouTube.');
        entry.account = { id: info.items[0].id, name: info.items[0].snippet.title };
      } else if (id === 'instagram') {
        const info = await remote(`${GRAPH}/${entry.graphVersion || 'v24.0'}/me?fields=user_id,username`, { headers: bearer(token.access_token) });
        entry.account = { id: String(info.user_id || token.user_id), name: info.username };
      } else {
        const info = await remote(`${TT}/user/info/?fields=open_id,display_name`, { headers: bearer(token.access_token) });
        entry.account = { id: info.data.user.open_id, name: info.data.user.display_name };
      }
      store.save();
    } catch (error) { entry.token = previous; throw error; }
  }
  async function access(id) {
    const entry = config(id);
    if (!entry.token) throw new Error(`Conecta tu cuenta de ${NAMES[id]}.`);
    if (entry.token.expiresAt > Date.now() + 120000) return entry.token.access_token;
    if (locks.has(id)) return locks.get(id);
    const promise = (async () => {
      let token;
      if (id === 'instagram') token = await remote(withQuery(`${GRAPH}/refresh_access_token`, { grant_type: 'ig_refresh_token', access_token: entry.token.access_token }));
      else {
        if (!entry.token.refresh_token) throw new Error('La sesión ha caducado. Vuelve a conectar la cuenta.');
        token = await remote(id === 'youtube' ? 'https://oauth2.googleapis.com/token' : `${TT}/oauth/token/`, form({
          [id === 'youtube' ? 'client_id' : 'client_key']: entry.clientId, client_secret: entry.clientSecret,
          grant_type: 'refresh_token', refresh_token: entry.token.refresh_token
        }));
      }
      if (!token.access_token) throw new Error('No se pudo renovar la sesión. Vuelve a conectar la cuenta.');
      entry.token = { ...entry.token, ...token, expiresAt: Date.now() + Number(token.expires_in) * 1000 };
      store.save();
      return token.access_token;
    })().finally(() => locks.delete(id));
    locks.set(id, promise);
    return promise;
  }
  async function creator() { return (await remote(`${TT}/post/publish/creator_info/query/`, json(await access('tiktok'), {}))).data; }
  async function disconnect(id) {
    const entry = config(id);
    if (entry.token) {
      if (id === 'youtube') await remote('https://oauth2.googleapis.com/revoke', form({ token: entry.token.access_token }));
      if (id === 'tiktok') await remote(`${TT}/oauth/revoke/`, form({ client_key: entry.clientId, client_secret: entry.clientSecret, token: entry.token.access_token }));
      if (id === 'instagram') await remote(`${GRAPH}/${entry.graphVersion || 'v24.0'}/${entry.account.id}/permissions`, { method: 'DELETE', headers: bearer(await access(id)) });
    }
    delete entry.token; delete entry.account; store.save();
  }
  async function uploadBytes(url, entry, start = 0, end = entry.size - 1, token, method = 'PUT', allowed = []) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowed.some(domain => target.hostname === domain || target.hostname.endsWith('.' + domain))) throw new Error('La plataforma devolvió una dirección de subida inesperada.');
    let response;
    try {
      response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30 * 60000),
        headers: { 'Content-Type': entry.mime, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${entry.size}`, ...(token ? bearer(token) : {}) },
        body: fs.createReadStream(entry.file, { start, end }), duplex: 'half' });
    } catch { throw new Error('La subida se interrumpió. Comprueba el estado en la plataforma antes de repetirla.'); }
    if (!response.ok) throw new Error(`La plataforma rechazó el archivo (${response.status}).`);
    return response;
  }
  async function publish(id, media, input, update, publicUrl) {
    const entry = config(id);
    const token = await access(id);
    const caption = input.description;
    update({ status: 'uploading', message: 'Enviando vídeo' });
    if (id === 'youtube') {
      let response;
      try {
        response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
          ...json(token, { snippet: { title: input.title.trim(), description: input.description, categoryId: '22' },
            status: { privacyStatus: input.youtubePrivacy, selfDeclaredMadeForKids: input.madeForKids === 'yes' } }),
          headers: { ...bearer(token), 'Content-Type': 'application/json', 'X-Upload-Content-Type': media.mime, 'X-Upload-Content-Length': String(media.size) },
          signal: AbortSignal.timeout(60000), redirect: 'error'
        });
      } catch { throw new Error('No se pudo iniciar la subida a YouTube.'); }
      if (!response.ok || !response.headers.get('location')) throw new Error(`YouTube rechazó el inicio de subida (${response.status}). Revisa permisos y cuota.`);
      const uploaded = await (await uploadBytes(response.headers.get('location'), media, 0, media.size - 1, token, 'PUT', ['googleapis.com'])).json();
      if (!uploaded.id) throw new Error('YouTube no devolvió el identificador del vídeo. Comprueba tu canal.');
      update({ remoteId: uploaded.id, status: 'processing', message: 'YouTube está procesando el vídeo', url: `https://www.youtube.com/watch?v=${uploaded.id}` });
    } else if (id === 'tiktok') {
      const chunkSize = Math.min(media.size, 10 * 1024 * 1024);
      const count = Math.max(1, Math.floor(media.size / chunkSize));
      const body = { source_info: { source: 'FILE_UPLOAD', video_size: media.size, chunk_size: chunkSize, total_chunk_count: count } };
      if (entry.tiktokMode !== 'inbox') {
        const info = await creator();
        if (!info.privacy_level_options?.includes(input.tiktokPrivacy)) throw new Error('Selecciona una privacidad de TikTok disponible para tu cuenta.');
        if (media.duration > info.max_video_post_duration_sec) throw new Error(`TikTok admite un máximo de ${info.max_video_post_duration_sec} segundos para esta cuenta.`);
        if (input.branded && input.tiktokPrivacy === 'SELF_ONLY') throw new Error('TikTok no permite contenido de marca en modo privado.');
        body.post_info = { title: caption, privacy_level: input.tiktokPrivacy, disable_comment: info.comment_disabled || !input.comments,
          disable_duet: info.duet_disabled || !input.duet, disable_stitch: info.stitch_disabled || !input.stitch,
          brand_content_toggle: !!input.branded, brand_organic_toggle: !!input.ownBrand, is_aigc: !!input.aiGenerated };
      }
      const result = await remote(`${TT}/post/publish/${entry.tiktokMode === 'inbox' ? 'inbox/video' : 'video'}/init/`, json(token, body));
      update({ remoteId: result.data.publish_id, mode: entry.tiktokMode });
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize, end = i === count - 1 ? media.size - 1 : start + chunkSize - 1;
        await uploadBytes(result.data.upload_url, media, start, end, null, 'PUT', ['tiktokapis.com']);
        update({ message: `Enviando vídeo · ${Math.round((end + 1) / media.size * 100)} %` });
      }
      update({ status: 'processing', message: 'TikTok está procesando el vídeo' });
    } else {
      const base = `${GRAPH}/${entry.graphVersion || 'v24.0'}`;
      const container = await remote(`${base}/${entry.account.id}/media`, { ...form({ media_type: 'REELS', video_url: publicUrl, caption, share_to_feed: String(!!input.shareToFeed) }), headers: bearer(token) });
      if (!container.id) throw new Error('Instagram no devolvió un contenedor.');
      update({ remoteId: container.id, status: 'processing', message: 'Instagram está procesando el vídeo', container: true });
    }
  }
  async function check(id, item, update) {
    if (!item.remoteId) return;
    const token = await access(id);
    if (id === 'youtube') {
      const data = await remote(withQuery('https://www.googleapis.com/youtube/v3/videos', { part: 'status,processingDetails', id: item.remoteId }), { headers: bearer(token) });
      const video = data.items?.[0];
      if (!video) throw new Error('No se ha encontrado el vídeo en YouTube.');
      if (['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus)) throw new Error(`YouTube rechazó el vídeo (${video.status.rejectionReason || video.status.failureReason || video.status.uploadStatus}).`);
      if (video.status.uploadStatus === 'processed') update({ status: 'done', message: `Vídeo disponible en YouTube (${video.status.privacyStatus})` });
    } else if (id === 'tiktok') {
      const result = (await remote(`${TT}/post/publish/status/fetch/`, json(token, { publish_id: item.remoteId }))).data;
      if (result.status === 'FAILED') throw new Error(`TikTok rechazó el vídeo (${result.fail_reason || 'sin detalle'}).`);
      if (result.status === 'PUBLISH_COMPLETE') update({ status: 'done', message: 'Publicado en TikTok' });
      if (result.status === 'SEND_TO_USER_INBOX') update({ status: 'inbox', message: 'Enviado a TikTok. Abre la notificación en TikTok, añade el texto y termina la publicación.' });
    } else {
      const entry = config(id), base = `${GRAPH}/${entry.graphVersion || 'v24.0'}`;
      if (!item.container) return;
      const result = await remote(`${base}/${item.remoteId}?fields=status_code`, { headers: bearer(token) });
      if (['ERROR', 'EXPIRED'].includes(result.status_code)) throw new Error(`Instagram no pudo procesar el vídeo (${result.status_code}).`);
      if (result.status_code === 'PUBLISHED') { update({ status: 'done', message: 'Publicado en Instagram' }); return; }
      if (result.status_code === 'FINISHED') {
        // Mark before the non-idempotent call. A lost response must not trigger an automatic second publication.
        if (item.publishAttempted) { update({ status: 'uncertain', message: 'No se pudo confirmar la publicación. Comprueba Instagram antes de repetirla.' }); return; }
        update({ publishAttempted: true });
        const published = await remote(`${base}/${entry.account.id}/media_publish`, { ...form({ creation_id: item.remoteId }), headers: bearer(token) });
        update({ status: 'done', message: 'Publicado en Instagram', publishedId: published.id });
      }
    }
  }
  return { authorization, exchange, access, creator, disconnect, publish, check, scopes };
}
module.exports = { createProviders, NAMES, remote };
