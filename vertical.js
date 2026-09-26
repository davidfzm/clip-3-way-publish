(() => {
  const dialog = $('#vertical-dialog');
  const original = document.createElement('video'); original.preload = 'auto'; original.playsInline = true;
  const cropCanvas = $('#crop-canvas'), output = $('#vertical-canvas');
  const ctx = cropCanvas.getContext('2d'), out = output.getContext('2d');
  const open = document.createElement('button'); open.type = 'button'; open.id = 'open-vertical'; open.textContent = 'Crear vertical';
  const revert = document.createElement('button'); revert.type = 'button'; revert.id = 'use-original'; revert.textContent = 'Usar original'; revert.hidden = true;
  $('#media-tools').prepend(open, revert);
  let template, defaults, engine, sourceId, cues = [], transcriptKey = '', taskId, raf, drag, overlayDrag, srtUrl, renderedId;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function note(text) { $('#editor-message').textContent = text; }
  function hasActivePost() { return jobs.some(job => Object.values(job.results).some(item => ['queued', 'uploading', 'processing'].includes(item.status))); }
  function refresh() {
    open.disabled = busy || !selectedFile || !state || hasActivePost();
    revert.hidden = !sourceMedia || !media || sourceMedia.id === media.id;
    revert.disabled = busy || hasActivePost();
    $('#editor-fields').disabled = busy;
    $('#close-vertical').disabled = busy;
    $('#cancel-edit').hidden = !taskId;
    $('#render-vertical').disabled = busy || !sourceId || ($('#enable-subtitles').checked && (!cues.some(cue => cue.text.trim()) || transcriptKey !== contextKey()));
    $('#transcribe-button').disabled = busy || !engine?.modelReady || !engine?.installed || !sourceMedia?.hasAudio;
  }
  function contextKey() { return JSON.stringify([sourceId, Number($('#clip-start').value), Number($('#clip-end').value), $('#subtitle-language').value, Number($('#subtitle-track').value)]); }
  function reset() {
    original.pause(); original.removeAttribute('src'); original.load(); sourceId = null; cues = []; transcriptKey = ''; renderedId = null;
    if (srtUrl) URL.revokeObjectURL(srtUrl); srtUrl = null; $('#download-srt').hidden = true;
    $('#subtitle-rows').replaceChildren(); $('#subtitle-review').hidden = true;
  }
  function fillTemplateFields() {
    $('#camera-height').value = Math.round(template.cameraHeight * 100);
    $('#camera-placement').value = template.cameraPlacement;
    $('#subtitle-y').value = Math.round(template.subtitleY * 100);
    $('#subtitle-size').value = template.fontSize; $('#subtitle-color').value = template.color;
    for (const key of ['x', 'y', 'w', 'h']) $(`#overlay-${key}`).value = +(template.overlay[key] * 100).toFixed(1);
    $('#overlay-settings').hidden = template.cameraPlacement !== 'overlay'; $('#camera-height-label').hidden = template.cameraPlacement === 'overlay';
    fillCropFields();
  }
  function fillCropFields() {
    const box = template[$('#crop-target').value];
    for (const key of ['x', 'y', 'w', 'h']) $(`#crop-${key}`).value = +(box[key] * 100).toFixed(1);
  }
  function drawCover(box, destination) {
    const sx = box.x * original.videoWidth, sy = box.y * original.videoHeight, sw = box.w * original.videoWidth, sh = box.h * original.videoHeight;
    const factor = Math.max(destination.w / sw, destination.h / sh);
    const visibleW = destination.w / factor, visibleH = destination.h / factor;
    out.drawImage(original, sx + (sw - visibleW) / 2, sy + (sh - visibleH) / 2, visibleW, visibleH, destination.x, destination.y, destination.w, destination.h);
  }
  function wrapText(text) {
    const result = []; let line = '';
    for (const word of text.replace(/[\r\n]+/g, ' ').split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (out.measureText(next).width > output.width - 80 && line) { result.push(line); line = word; } else line = next;
    }
    if (line) result.push(line); return result;
  }
  function draw() {
    if (!template || original.readyState < 2 || !original.videoWidth) return;
    ctx.drawImage(original, 0, 0, cropCanvas.width, cropCanvas.height);
    for (const name of ['camera', 'game']) {
      const box = template[name]; ctx.strokeStyle = name === 'camera' ? '#68a4ff' : '#6bdf91'; ctx.lineWidth = 3;
      ctx.strokeRect(box.x * cropCanvas.width, box.y * cropCanvas.height, box.w * cropCanvas.width, box.h * cropCanvas.height);
      ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(name === 'camera' ? 'Cámara' : 'Gameplay', box.x * cropCanvas.width + 6, box.y * cropCanvas.height + 21);
    }
    const width = output.width, height = output.height, top = Math.round(height * template.cameraHeight);
    out.fillStyle = '#111'; out.fillRect(0, 0, width, height);
    if (template.cameraPlacement === 'overlay') {
      drawCover(template.game, { x: 0, y: 0, w: width, h: height });
      const box = template.overlay; drawCover(template.camera, { x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height });
    } else {
      const bottom = template.cameraPlacement === 'bottom';
      drawCover(template.camera, { x: 0, y: bottom ? height - top : 0, w: width, h: top });
      drawCover(template.game, { x: 0, y: bottom ? 0 : top, w: width, h: height - top });
    }
    if ($('#enable-subtitles').checked) {
      const time = original.currentTime - Number($('#clip-start').value);
      const cue = cues.find(cue => time >= cue.start && time < cue.end);
      const text = cue?.text || (!cues.length ? 'Vista previa de subtítulos' : '');
      out.font = `bold ${template.fontSize / 2}px Arial`; out.textAlign = 'center'; out.textBaseline = 'middle';
      out.fillStyle = template.color === 'yellow' ? '#ffff00' : '#fff'; out.strokeStyle = '#000'; out.lineWidth = 4; out.lineJoin = 'round';
      const lines = wrapText(text), lineHeight = template.fontSize / 2 * 1.15;
      lines.forEach((line, index) => { const y = height * template.subtitleY + (index - (lines.length - 1) / 2) * lineHeight; out.strokeText(line, width / 2, y); out.fillText(line, width / 2, y); });
    }
    $('#frame-time').value = `${original.currentTime.toFixed(1)} s`;
    $('#frame-position').value = original.currentTime;
  }
  function animate() {
    draw();
    if (!original.paused && original.currentTime >= Number($('#clip-end').value)) original.pause();
    if (dialog.open && !original.paused) raf = requestAnimationFrame(animate);
  }
  original.addEventListener('seeked', draw); original.addEventListener('loadeddata', draw);
  original.addEventListener('pause', () => { $('#editor-play').textContent = 'Reproducir vista previa'; cancelAnimationFrame(raf); draw(); });
  original.addEventListener('error', () => note('No se puede previsualizar el original en este navegador. Usa un MP4 compatible como archivo de entrada.'));
  $('#editor-play').addEventListener('click', async () => {
    if (!original.paused) return original.pause();
    if (original.currentTime < Number($('#clip-start').value) || original.currentTime >= Number($('#clip-end').value)) original.currentTime = Number($('#clip-start').value);
    try { await original.play(); $('#editor-play').textContent = 'Pausar vista previa'; animate(); }
    catch { note('El navegador no puede reproducir la vista previa. Comprueba el formato del original.'); }
  });
  $('#editor-mute').addEventListener('click', () => { original.muted = !original.muted; $('#editor-mute').textContent = original.muted ? 'Activar sonido de vista previa' : 'Silenciar vista previa'; });
  $('#frame-position').addEventListener('input', event => { original.currentTime = Number(event.target.value); });
  const point = (event, canvas) => { const box = canvas.getBoundingClientRect(); return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) }; };
  cropCanvas.addEventListener('pointerdown', event => { if (busy || !template) return; original.pause(); drag = point(event, cropCanvas); cropCanvas.setPointerCapture(event.pointerId); });
  cropCanvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const end = point(event, cropCanvas); const box = { x: Math.min(drag.x, end.x), y: Math.min(drag.y, end.y), w: Math.abs(end.x - drag.x), h: Math.abs(end.y - drag.y) };
    if (box.w >= 0.02 && box.h >= 0.02) { template[$('#crop-target').value] = box; fillCropFields(); draw(); }
  });
  for (const event of ['pointerup', 'pointercancel']) cropCanvas.addEventListener(event, () => { drag = null; });
  output.addEventListener('pointerdown', event => {
    if (busy || template?.cameraPlacement !== 'overlay') return;
    const p = point(event, output), box = template.overlay;
    if (p.x < box.x || p.x > box.x + box.w || p.y < box.y || p.y > box.y + box.h) return;
    overlayDrag = { x: p.x - box.x, y: p.y - box.y }; output.setPointerCapture(event.pointerId);
  });
  output.addEventListener('pointermove', event => {
    if (!overlayDrag) return;
    const p = point(event, output); template.overlay.x = clamp(p.x - overlayDrag.x, 0, 1 - template.overlay.w); template.overlay.y = clamp(p.y - overlayDrag.y, 0, 1 - template.overlay.h);
    fillTemplateFields(); draw();
  });
  for (const event of ['pointerup', 'pointercancel']) output.addEventListener(event, () => { overlayDrag = null; });
  $('#crop-target').addEventListener('change', fillCropFields);
  function readBox(prefix, target) {
    const values = Object.fromEntries(['x', 'y', 'w', 'h'].map(key => [key, Number($(`#${prefix}-${key}`).value) / 100]));
    if (Object.values(values).some(value => !Number.isFinite(value))) return;
    values.w = clamp(values.w, 0.02, 1); values.h = clamp(values.h, 0.02, 1);
    values.x = clamp(values.x, 0, 1 - values.w); values.y = clamp(values.y, 0, 1 - values.h);
    template[target] = values; draw();
  }
  for (const key of ['x', 'y', 'w', 'h']) {
    $(`#crop-${key}`).addEventListener('change', () => { readBox('crop', $('#crop-target').value); fillCropFields(); });
    $(`#overlay-${key}`).addEventListener('change', () => { readBox('overlay', 'overlay'); fillTemplateFields(); });
  }
  for (const id of ['camera-height', 'camera-placement', 'subtitle-y', 'subtitle-size', 'subtitle-color']) $( '#' + id).addEventListener('input', () => {
    template.cameraHeight = clamp(Number($('#camera-height').value) / 100, 0.15, 0.4);
    template.cameraPlacement = $('#camera-placement').value;
    template.subtitleY = clamp(Number($('#subtitle-y').value) / 100, 0.35, 0.85);
    template.fontSize = clamp(Number($('#subtitle-size').value), 36, 88); template.color = $('#subtitle-color').value;
    $('#overlay-settings').hidden = template.cameraPlacement !== 'overlay'; $('#camera-height-label').hidden = template.cameraPlacement === 'overlay'; draw();
  });
  $('#reset-template').addEventListener('click', () => { template = clone(defaults); fillTemplateFields(); draw(); note('Plantilla de la captura restaurada. Guarda para reutilizarla.'); });
  $('#save-template').addEventListener('click', () => {
    try { localStorage.setItem('3wayclip-vertical-template', JSON.stringify(template)); note('Plantilla guardada en este navegador para los próximos clips.'); }
    catch { note('El navegador no permite guardar la plantilla.'); }
  });
  for (const id of ['clip-start', 'clip-end', 'subtitle-language', 'subtitle-track']) $('#' + id).addEventListener('change', () => { original.pause(); if (cues.length && transcriptKey !== contextKey()) note('Has cambiado el fragmento o la pista de voz. Regenera los subtítulos para sincronizarlos.'); refresh(); draw(); });
  $('#enable-subtitles').addEventListener('change', () => { $('#subtitle-controls').hidden = !$('#enable-subtitles').checked; refresh(); draw(); });
  function srtDownload(text) {
    if (srtUrl) URL.revokeObjectURL(srtUrl);
    srtUrl = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' })); $('#download-srt').href = srtUrl; $('#download-srt').hidden = false;
  }
  function renderCues() {
    const root = $('#subtitle-rows'); root.replaceChildren(); $('#subtitle-review').hidden = !cues.length;
    cues.forEach((cue, index) => {
      const row = document.createElement('div'); row.className = 'subtitle-row';
      for (const key of ['start', 'end']) {
        const label = document.createElement('label'); label.textContent = key === 'start' ? 'Inicio' : 'Fin';
        const field = document.createElement('input'); field.type = 'number'; field.min = '0'; field.step = '0.01'; field.value = cue[key]; field.setAttribute('aria-label', `${key === 'start' ? 'Inicio' : 'Fin'} de frase ${index + 1}`);
        field.addEventListener('input', () => { cue[key] = Number(field.value); $('#download-srt').hidden = true; draw(); }); label.append(field); row.append(label);
      }
      const text = document.createElement('textarea'); text.value = cue.text; text.maxLength = 300; text.rows = 2; text.setAttribute('aria-label', `Texto de frase ${index + 1}`);
      text.addEventListener('input', () => { cue.text = text.value; $('#download-srt').hidden = true; refresh(); draw(); }); row.append(text);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Eliminar frase ${index + 1}`);
      remove.addEventListener('click', () => { cues.splice(index, 1); $('#download-srt').hidden = true; renderCues(); refresh(); draw(); }); row.append(remove); root.append(row);
    });
  }
  $('#add-subtitle').addEventListener('click', () => {
    const end = Number($('#clip-end').value) - Number($('#clip-start').value), start = cues.at(-1)?.end || 0;
    if (start >= end) return note('No queda tiempo al final. Ajusta el fin de la última frase.');
    cues.push({ start, end: Math.min(end, start + 2), text: '' }); renderCues(); refresh();
  });
  function clipInput() {
    const start = Number($('#clip-start').value), end = Number($('#clip-end').value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > sourceMedia.duration + 0.05 || end <= start || end - start > 180.05) throw new Error('Elige un intervalo válido de hasta 180 segundos dentro del vídeo.');
    return { mediaId: sourceId, start, end, audioTrack: Number($('#subtitle-track').value), language: $('#subtitle-language').value };
  }
  async function runTask(kind, payload) {
    original.pause(); busy = true; updateButton(); $('#editor-progress').hidden = false; $('#editor-progress').value = 0;
    try {
      let task = await api(`/api/editor/${kind}`, payload); taskId = task.id; refresh();
      while (task.status === 'running') {
        note(task.message); $('#editor-progress').value = task.progress;
        await new Promise(resolve => setTimeout(resolve, 800));
        task = await api(`/api/editor/tasks/${task.id}`);
      }
      if (task.status !== 'done') throw new Error(task.message);
      note(task.message); $('#editor-progress').value = 100; return task.result;
    } finally { taskId = null; busy = false; $('#editor-progress').hidden = true; updateButton(); }
  }
  $('#transcribe-button').addEventListener('click', async () => {
    try {
      const key = contextKey(), result = await runTask('transcribe', clipInput());
      cues = result.segments; transcriptKey = key; renderCues(); draw(); refresh();
    } catch (error) { note(error.message); }
  });
  $('#render-vertical').addEventListener('click', async () => {
    try {
      const payload = { ...clipInput(), template, subtitles: $('#enable-subtitles').checked, segments: cues };
      const result = await runTask('render', payload);
      media = result.media; renderedId = media.id; posted = false; requestId = crypto.randomUUID();
      video.pause(); video.src = media.url; video.load();
      $('#file-size').textContent = `${(media.size / 1024 / 1024).toFixed(1)} MB · Vertical 1080 × 1920`;
      $('#download-video').href = media.url; $('#download-video').download = 'clip-vertical.mp4'; $('#download-video').textContent = 'Descargar vídeo vertical'; $('#download-video').hidden = false;
      if (result.srt) srtDownload(result.srt);
      displayMetadata(); updateButton(); dialog.close(); showMessage('Vertical creado. Reprodúcelo para revisar el resultado antes de compartir.');
    } catch (error) { note(error.message); }
  });
  $('#cancel-edit').addEventListener('click', async () => { if (taskId) { try { await api(`/api/editor/tasks/${taskId}/cancel`, {}); note('Cancelando…'); } catch (error) { note(error.message); } } });
  $('#close-vertical').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { original.pause(); cancelAnimationFrame(raf); });
  revert.addEventListener('click', () => {
    media = sourceMedia; video.pause(); video.src = objectUrl; video.load(); renderedId = null; posted = false; requestId = crypto.randomUUID();
    $('#download-video').hidden = true; $('#file-size').textContent = `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB · Original`;
    displayMetadata(); updateButton(); showMessage('Se usará el vídeo original para publicar.');
  });
  open.addEventListener('click', async () => {
    video.pause(); dialog.showModal(); busy = true; updateButton(); note('Cargando el original y preparando la vista previa…');
    try {
      engine = await api('/api/editor/status'); defaults = engine.template;
      if (!template) {
        template = clone(defaults);
        try {
          const saved = JSON.parse(localStorage.getItem('3wayclip-vertical-template') || 'null');
          if (saved && ['camera', 'game', 'overlay'].every(key => saved[key] && ['x', 'y', 'w', 'h'].every(axis => Number.isFinite(saved[key][axis])))) template = { ...template, ...saved };
        } catch {}
      }
      sourceMedia ||= await upload();
      const changed = sourceId !== sourceMedia.id; sourceId = sourceMedia.id;
      if (changed) {
        cues = []; transcriptKey = ''; renderCues(); original.src = objectUrl;
        await new Promise((resolve, reject) => { original.onloadedmetadata = resolve; original.onerror = () => reject(new Error('El navegador no puede cargar la vista previa del original.')); original.load(); });
        cropCanvas.height = Math.round(cropCanvas.width * original.videoHeight / original.videoWidth);
        $('#clip-start').value = 0; $('#clip-end').value = Math.min(180, Math.floor(sourceMedia.duration * 10) / 10);
        $('#frame-position').max = sourceMedia.duration; $('#clip-start').max = sourceMedia.duration; $('#clip-end').max = sourceMedia.duration;
        const tracks = $('#subtitle-track'); tracks.replaceChildren();
        for (const track of sourceMedia.audioTrackInfo || []) tracks.add(new Option(`${track.label} (${track.codec})`, track.index));
        if (!tracks.options.length) tracks.add(new Option('Sin audio', 0));
        $('#enable-subtitles').checked = sourceMedia.hasAudio;
        $('#subtitle-controls').hidden = !$('#enable-subtitles').checked;
      }
      fillTemplateFields(); draw();
      $('#subtitle-engine').textContent = engine.installed && engine.modelReady ? 'Motor local preparado.' : 'Falta preparar el motor local. Ejecuta npm run setup:subtitles (descarga inicial del modelo). Puedes crear el vertical sin subtítulos.';
      note(sourceMedia.duration > 180 ? 'Se han seleccionado los primeros 180 segundos. Ajusta Inicio y Fin para elegir otro fragmento.' : 'Ajusta el encuadre y reproduce la vista previa. Genera los subtítulos antes de exportar.');
    } catch (error) { note(error.message); }
    finally { busy = false; updateButton(); }
  });
  window.clipEditor = { reset, refresh }; refresh();
})();
