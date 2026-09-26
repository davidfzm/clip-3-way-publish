const $ = selector => document.querySelector(selector);
const video = $('#video-preview');
const input = $('#video-input');
const title = $('#title');
const description = $('#description');
const message = $('#form-message');
const names = { tiktok: 'TikTok', youtube: 'YouTube Shorts', instagram: 'Instagram Reels' };
let state, selectedFile, media, sourceMedia, objectUrl, busy = false, requestId = crypto.randomUUID(), posted = false, creatorInfo;
let mediaGeneration = 0, uploadPromise, jobs = [], polling = false;

function showMessage(text) { message.textContent = text; message.hidden = !text; }
async function api(url, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(url, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf || '' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo completar la solicitud.');
  return result;
}
function selectedNetworks() { return [...document.querySelectorAll('[name="platform"]:checked')].map(el => el.value); }
function updateTextDestinations() {
  const selected = selectedNetworks();
  const youtube = selected.includes('youtube');
  const inbox = selected.includes('tiktok') && (state?.providers.tiktok.tiktokMode || 'inbox') === 'inbox';
  $('#youtube-title-fields').hidden = !youtube;
  title.disabled = !youtube; title.required = youtube;
  const destinations = selected.filter(id => id !== 'tiktok' || !inbox).map(id => names[id]);
  $('#text-destinations').textContent = (destinations.length ? `Descripción para ${destinations.join(', ')}. Límite del texto compartido: 2.200 caracteres.` : selected.length ? 'Texto para copiar en TikTok; no se envía con el vídeo en modo bandeja.' : 'Selecciona las redes de destino.')
    + (inbox && destinations.length ? ' En TikTok (bandeja), pégala al terminar la publicación.' : '');
  $('#copy-description').hidden = !inbox;
  $('#copy-description').disabled = !description.value;
  const invalid = youtube && (new TextEncoder().encode(description.value).length > 5000 || /[<>]/.test(description.value));
  const error = invalid ? 'YouTube admite hasta 5.000 bytes UTF-8 y no permite < ni > en la descripción. Acorta o corrige el texto.' : '';
  description.setCustomValidity(error);
  $('#text-validation').textContent = error; $('#text-validation').hidden = !error;
}
function updateButton() {
  updateTextDestinations();
  const selected = selectedNetworks();
  const missing = selected.filter(id => !state?.providers[id]?.connected);
  const active = jobs.some(job => Object.values(job.results).some(result => ['queued', 'uploading', 'processing'].includes(result.status)));
  let reason = !state ? 'No hay conexión con el servidor.' : busy ? 'Procesando vídeo…' : active ? 'Publicación en curso. Consulta los estados debajo.' : posted ? 'Esta publicación ya se ha enviado. Selecciona otro vídeo para preparar una nueva.' : !selectedFile ? 'Selecciona un vídeo.' : !selected.length ? 'Selecciona al menos una red.' : missing.length ? `Conecta: ${missing.map(id => names[id]).join(', ')}.` : selected.includes('instagram') && !state.publicOrigin ? 'Configura la URL pública de Instagram en Cuentas y API.' : '';
  $('.share-button').disabled = !!reason;
  $('#publish-status').textContent = reason || `Enviar a ${selected.map(id => names[id]).join(', ')}.`;
  $('#convert-button').disabled = busy || active || !selectedFile;
  input.disabled = busy || active;
  $('#remove-video').disabled = busy || active;
  for (const id of Object.keys(names)) $(`#${id}-options`).hidden = !selected.includes(id);
  $('#accounts-button').disabled = busy;
  window.clipEditor?.refresh();
}
function displayMetadata() {
  if (!media) return;
  $('#media-details').textContent = `${media.width} × ${media.height} · ${media.duration.toFixed(1)} s · ${media.videoCodec} · ${media.hasAudio ? `Audio: ${media.audioCodec}${media.audioTracks > 1 ? ` (${media.audioTracks} pistas; se convierte la primera)` : ''}` : 'El archivo no contiene ninguna pista de audio'}`;
}
function chooseFile(file) {
  if (busy || jobs.some(job => Object.values(job.results).some(item => ['queued', 'uploading', 'processing'].includes(item.status)))) return;
  if (!file) return;
  if (!/\.(mp4|mov|webm)$/i.test(file.name) || (file.type && !['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type))) return showMessage('Selecciona un vídeo MP4, MOV o WebM.');
  if (!file.size || file.size > 500 * 1024 * 1024) return showMessage('El archivo debe contener datos y no superar los 500 MB.');
  mediaGeneration++;
  selectedFile = file; media = null; sourceMedia = null; uploadPromise = null; posted = false; requestId = crypto.randomUUID();
  window.clipEditor?.reset();
  video.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  video.load(); video.hidden = false;
  $('#preview-placeholder').hidden = true; $('#file-info').hidden = false; $('#media-tools').hidden = false;
  $('#file-name').textContent = file.name;
  $('#file-size').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  $('#upload-title').textContent = 'Cambiar vídeo';
  $('#media-details').textContent = 'Archivo original.';
  $('#download-video').hidden = true;
  showMessage(''); updateButton();
}
input.addEventListener('change', () => chooseFile(input.files[0]));
for (const name of ['dragenter', 'dragover']) $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); });
$('#dropzone').addEventListener('drop', event => {
  if (event.dataTransfer.files.length !== 1) return showMessage('Selecciona un solo vídeo.');
  chooseFile(event.dataTransfer.files[0]);
});
$('#remove-video').addEventListener('click', () => {
  mediaGeneration++; selectedFile = null; media = null; sourceMedia = null; uploadPromise = null; posted = false; requestId = crypto.randomUUID();
  window.clipEditor?.reset();
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; input.value = '';
  $('#file-info').hidden = true; $('#media-tools').hidden = true; $('#preview-placeholder').hidden = false;
  $('#upload-title').textContent = 'Seleccionar vídeo'; showMessage(''); updateButton();
});
video.addEventListener('error', () => { if (selectedFile) showMessage('El navegador no puede reproducir este archivo. Prueba «Convertir a MP4 compatible».'); });

function upload() {
  if (media) return Promise.resolve(media);
  if (uploadPromise) return uploadPromise;
  const generation = mediaGeneration;
  const file = selectedFile;
  uploadPromise = new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    const mime = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : /\.webm$/i.test(file.name) ? 'video/webm' : 'video/mp4');
    xhr.setRequestHeader('Content-Type', mime); xhr.setRequestHeader('X-CSRF-Token', state.csrf);
    xhr.timeout = 30 * 60000;
    $('#upload-progress').hidden = false;
    xhr.upload.onprogress = event => { if (event.lengthComputable) $('#upload-progress').value = event.loaded / event.total * 100; };
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Se interrumpió la subida al servidor local.'));
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) throw new Error(result.error);
        if (generation !== mediaGeneration) throw new Error('El vídeo seleccionado ha cambiado.');
        media = result; sourceMedia ||= result; displayMetadata(); resolve(result);
      } catch (error) { reject(error); }
    };
    xhr.send(file);
  }).finally(() => { uploadPromise = null; $('#upload-progress').hidden = true; });
  return uploadPromise;
}
$('#convert-button').addEventListener('click', async () => {
  if (!selectedFile || busy || !state) return;
  busy = true; updateButton(); showMessage('Convirtiendo en este equipo. Puede tardar varios minutos.');
  try {
    const original = await upload();
    media = await api(`/api/uploads/${original.id}/convert`, {});
    video.pause(); video.src = media.url;
    video.load();
    displayMetadata(); $('#file-size').textContent = `${(media.size / 1024 / 1024).toFixed(1)} MB · Copia MP4 compatible`;
    $('#download-video').href = media.url; $('#download-video').hidden = false;
    showMessage(media.hasAudio ? 'Conversión terminada. Se usará la copia MP4 para publicar.' : 'El vídeo original no contiene audio; la conversión no puede añadirlo.');
  } catch (error) { showMessage(error.message); }
  finally { busy = false; updateButton(); }
});
function updateText() {
  $('#character-count').textContent = `${description.value.length.toLocaleString('es-ES')} / 2.200`;
  updateTextDestinations();
  try { localStorage.setItem('clip-draft', JSON.stringify({ title: title.value, description: description.value })); $('#draft-status').textContent = 'Título y descripción guardados en este navegador.'; }
  catch { $('#draft-status').textContent = 'No se puede guardar el borrador en este navegador.'; }
}
try { const draft = JSON.parse(localStorage.getItem('clip-draft') || '{}'); title.value = typeof draft.title === 'string' ? draft.title.slice(0, 100) : ''; description.value = typeof draft.description === 'string' ? draft.description.slice(0, 2200) : ''; } catch {}
title.addEventListener('input', updateText); description.addEventListener('input', updateText); updateText();
$('#copy-description').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(description.value); showMessage('Descripción copiada para pegarla en TikTok.'); }
  catch { showMessage('No se pudo acceder al portapapeles. Selecciona la descripción y cópiala manualmente.'); }
});
document.querySelectorAll('[name="platform"]').forEach(el => el.addEventListener('change', updateButton));

async function loadCreator() {
  creatorInfo = null;
  const config = state.providers.tiktok;
  $('#tiktok-direct').hidden = config.tiktokMode !== 'direct';
  $('#tiktok-mode-note').textContent = config.tiktokMode === 'inbox' ? 'Modo bandeja: se envía el vídeo; tendrás que añadir el texto y publicar desde la notificación de TikTok.' : 'Direct Post: la disponibilidad y la visibilidad dependen de la aprobación de tu aplicación.';
  if (!config.connected || config.tiktokMode !== 'direct') return;
  try {
    creatorInfo = await api('/api/tiktok/creator');
    $('#creator-name').textContent = `${creatorInfo.creator_nickname} · Máximo ${creatorInfo.max_video_post_duration_sec} s`;
    const select = $('#tiktok-privacy'); select.replaceChildren(new Option('Seleccionar privacidad', ''));
    const labels = { SELF_ONLY: 'Solo yo', PUBLIC_TO_EVERYONE: 'Todo el mundo', MUTUAL_FOLLOW_FRIENDS: 'Amigos', FOLLOWER_OF_CREATOR: 'Seguidores' };
    for (const value of creatorInfo.privacy_level_options) select.add(new Option(labels[value] || value, value));
    for (const key of ['comments', 'duet', 'stitch']) {
      const checkbox = $(`#tt-${key}`); checkbox.disabled = !!creatorInfo[key === 'comments' ? 'comment_disabled' : key + '_disabled'];
      if (checkbox.disabled) checkbox.checked = false;
    }
  } catch (error) { $('#creator-name').textContent = error.message; }
}
function renderAccounts() {
  const root = $('#account-forms'); root.replaceChildren();
  $('#account-summary').replaceChildren();
  const docs = { youtube: 'https://console.cloud.google.com/apis/credentials', tiktok: 'https://developers.tiktok.com/', instagram: 'https://developers.facebook.com/apps/' };
  for (const [id, config] of Object.entries(state.providers)) {
    const accountName = config.connected ? config.account?.name || 'Conectada' : 'Sin conectar';
    const summary = document.createElement('p'); summary.className = `connection-item ${config.connected ? 'is-connected' : 'is-disconnected'}`;
    const summaryIcon = document.createElement('span'); summaryIcon.className = 'connection-icon'; summaryIcon.textContent = config.connected ? '✓' : '·'; summaryIcon.setAttribute('aria-hidden', 'true'); summaryIcon.style.cssText = config.connected ? 'background:#16803c;color:#fff' : 'background:#edf0f3;color:#7a828c';
    summary.append(summaryIcon, document.createTextNode(`${names[id]}: ${accountName}`)); $('#account-summary').append(summary);
    const form = document.createElement('form'); form.className = 'credentials-form';
    // Static markup only. Account data and saved credentials are assigned as text/value below.
    form.innerHTML = `<h3></h3><p class="account-status hint"></p><a class="developer-link" target="_blank" rel="noreferrer">Crear o consultar aplicación</a>
      <label>Client ID / App ID / Client Key<input name="clientId" required autocomplete="off"></label>
      <label>Client Secret / App Secret<input name="clientSecret" type="password" autocomplete="new-password"></label>
      <label>URL de retorno OAuth<input name="redirectUri" type="url" required></label>
      <p class="hint">Registra esta misma URL de retorno en la aplicación del proveedor.</p>
      <div class="provider-specific"></div><div class="account-buttons"><button type="submit">Guardar credenciales</button><button type="button" class="connect">Iniciar sesión</button><button type="button" class="disconnect">Desconectar</button></div><p class="form-feedback" role="status"></p>`;
    form.querySelector('h3').textContent = names[id];
    const status = form.querySelector('.account-status'); status.className = `account-status hint ${config.connected ? 'is-connected' : 'is-disconnected'}`;
    const statusIcon = document.createElement('span'); statusIcon.className = 'connection-icon'; statusIcon.textContent = config.connected ? '✓' : '·'; statusIcon.setAttribute('aria-hidden', 'true'); statusIcon.style.cssText = config.connected ? 'background:#16803c;color:#fff' : 'background:#edf0f3;color:#7a828c';
    status.append(statusIcon, document.createTextNode(config.connected ? `Conectada: ${config.account?.name || config.account?.id}` : 'Sin conectar'));
    form.querySelector('.developer-link').href = docs[id];
    form.elements.clientId.value = config.clientId;
    form.elements.clientSecret.placeholder = config.hasSecret ? 'Guardado; deja vacío para conservarlo' : 'Secreto de la aplicación';
    form.elements.clientSecret.required = !config.hasSecret;
    form.elements.redirectUri.value = config.redirectUri;
    const extra = form.querySelector('.provider-specific');
    if (id === 'tiktok') {
      extra.innerHTML = `<label>Tipo de Login Kit<select name="tiktokLogin"><option value="desktop">Desktop (localhost)</option><option value="web">Web (HTTPS público)</option></select></label><label>Modo de envío<select name="tiktokMode"><option value="inbox">Enviar a TikTok para terminar allí</option><option value="direct">Publicar directamente (Direct Post)</option></select></label><p class="hint">Activa Login Kit y Content Posting API. El modo bandeja necesita video.upload; Direct Post necesita video.publish. TikTok no aprueba Direct Post para herramientas exclusivamente personales y limita clientes sin auditoría a privado. El modo bandeja también necesita aprobación del permiso.</p>`;
      form.elements.tiktokLogin.value = config.tiktokLogin; form.elements.tiktokMode.value = config.tiktokMode;
    } else if (id === 'instagram') {
      extra.innerHTML = `<label>Versión de Graph API<input name="graphVersion" pattern="v[0-9]{2}\\.0" required></label><p class="hint">Usa Instagram API con Instagram Login y una cuenta profesional (creador o empresa). Permisos: instagram_business_basic e instagram_business_content_publish. El App ID y el secreto son los de Instagram. Necesita una URL de retorno HTTPS.</p>`;
      form.elements.graphVersion.value = config.graphVersion;
    } else extra.innerHTML = `<p class="hint">Activa YouTube Data API v3. Crea un cliente OAuth de tipo Aplicación web. En modo de prueba, añade tu cuenta como usuario de prueba. Los proyectos sin auditoría pueden tener las subidas restringidas a privado.</p>`;
    const connect = form.querySelector('.connect'); connect.disabled = !config.configured;
    const disconnect = form.querySelector('.disconnect'); disconnect.hidden = !config.connected;
    form.addEventListener('input', () => { connect.disabled = true; form.querySelector('.form-feedback').textContent = 'Guarda los cambios antes de iniciar sesión.'; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); const feedback = form.querySelector('.form-feedback'); const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        await api(`/api/settings/${id}`, Object.fromEntries(new FormData(form)));
        form.elements.clientSecret.value = '';
        await loadState();
        $('#connection-message').textContent = `Credenciales de ${names[id]} guardadas. Pulsa Iniciar sesión.`; $('#connection-message').hidden = false;
      } catch (error) { feedback.textContent = error.message; } finally { button.disabled = false; }
    });
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      // Open immediately after the click so the official login is not blocked as a popup.
      const login = window.open('about:blank', '_blank');
      try {
        const result = await api(`/api/connect/${id}`, {});
        if (login) { login.opener = null; login.location.href = result.url; }
        else form.querySelector('.form-feedback').textContent = 'Permite las ventanas emergentes e inténtalo de nuevo.';
      } catch (error) { login?.close(); form.querySelector('.form-feedback').textContent = error.message; }
      finally { connect.disabled = false; }
    });
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      try { await api(`/api/disconnect/${id}`, {}); await loadState(); }
      catch (error) { form.querySelector('.form-feedback').textContent = error.message; }
      finally { disconnect.disabled = false; }
    });
    root.append(form);
  }
  $('#public-origin').value = state.publicOrigin;
}
async function loadState() {
  state = await api('/api/state'); jobs = state.jobs; renderAccounts(); await loadCreator(); renderJobs(); updateButton();
}
$('#accounts-button').addEventListener('click', () => $('#accounts-dialog').showModal());
$('#close-accounts').addEventListener('click', () => $('#accounts-dialog').close());
$('#public-form').addEventListener('submit', async event => {
  event.preventDefault(); const feedback = $('#public-form .form-feedback');
  try { await api('/api/settings/public', { publicOrigin: $('#public-origin').value.trim() }); state.publicOrigin = $('#public-origin').value.trim(); feedback.textContent = 'URL guardada.'; updateButton(); }
  catch (error) { feedback.textContent = error.message; }
});
function renderJobs() {
  $('#results-section').hidden = !jobs.length;
  const root = $('#results'); root.replaceChildren();
  for (const job of [...jobs].reverse().slice(0, 10)) {
    const group = document.createElement('article'); group.className = 'job';
    const heading = document.createElement('h3'); heading.textContent = `${job.title || 'Publicación'} · ${new Date(job.createdAt).toLocaleString('es-ES')}`; group.append(heading);
    for (const [id, result] of Object.entries(job.results)) {
      const row = document.createElement('p'); row.dataset.status = result.status; row.textContent = `${names[id]}${result.account ? ` (${result.account})` : ''}: ${result.message}`;
      if (result.url) { const link = document.createElement('a'); link.href = result.url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = ' Abrir vídeo'; row.append(link); }
      if (result.remoteId) { const ref = document.createElement('small'); ref.textContent = ` ID: ${result.remoteId}`; row.append(ref); }
      group.append(row);
    }
    root.append(group);
  }
}
async function refreshJobs(remote = false) {
  if (!state || polling) return;
  polling = true;
  try {
    jobs = await Promise.all(jobs.map(job => remote ? api(`/api/jobs/${job.id}/refresh`, {}) : api(`/api/jobs/${job.id}`)));
    renderJobs(); updateButton();
  } catch (error) { showMessage(error.message); }
  finally { polling = false; }
}
$('#refresh-jobs').addEventListener('click', () => refreshJobs(true));
$('#publish-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('.share-button').disabled || busy) return;
  const platforms = selectedNetworks();
  if (platforms.includes('youtube') && (!title.value.trim() || !$('#made-for-kids').value)) return showMessage('YouTube necesita un título y que indiques si el vídeo está creado para niños.');
  if (platforms.includes('tiktok') && state.providers.tiktok.tiktokMode === 'direct' && (!creatorInfo || !$('#tiktok-privacy').value || !$('#tt-consent').checked)) return showMessage('Revisa la privacidad y la confirmación de TikTok.');
  busy = true; updateButton(); showMessage('');
  try {
    const file = await upload();
    const payload = { requestId, mediaId: file.id, title: platforms.includes('youtube') ? title.value : '', description: description.value, platforms,
      youtubePrivacy: $('#youtube-privacy').value, madeForKids: $('#made-for-kids').value, tiktokPrivacy: $('#tiktok-privacy').value,
      comments: $('#tt-comments').checked, duet: $('#tt-duet').checked, stitch: $('#tt-stitch').checked,
      ownBrand: $('#tt-own-brand').checked, branded: $('#tt-branded').checked, aiGenerated: $('#tt-ai').checked,
      tiktokConsent: $('#tt-consent').checked, shareToFeed: $('#share-to-feed').checked };
    const job = await api('/api/publish', payload);
    if (!jobs.some(existing => existing.id === job.id)) jobs.push(job);
    posted = true; renderJobs();
  } catch (error) { showMessage(error.message); }
  finally { busy = false; updateButton(); }
});
const connectionResult = new URLSearchParams(location.search).get('connection');
if (connectionResult) { $('#connection-message').textContent = connectionResult; $('#connection-message').hidden = false; history.replaceState(null, '', '/'); }
loadState().catch(error => { showMessage(`No se pudo conectar con el servidor: ${error.message}`); updateButton(); });
// Refresh after returning from the official login window without resetting a selected video.
window.addEventListener('focus', async () => {
  if (!state || busy) return;
  try {
    const next = await api('/api/state');
    const changed = JSON.stringify(next.providers) !== JSON.stringify(state.providers);
    state = next;
    if (changed) { renderAccounts(); await loadCreator(); }
    jobs = next.jobs; renderJobs(); updateButton();
  } catch {}
});
setInterval(() => { if (jobs.some(job => Object.values(job.results).some(result => ['queued', 'uploading', 'processing'].includes(result.status)))) void refreshJobs(); }, 4000);
