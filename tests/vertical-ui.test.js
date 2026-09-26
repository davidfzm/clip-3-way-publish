const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { DEFAULT_TEMPLATE } = require('../lib/editor');

test('Vertical editor controls update the preview, save crops, invalidate stale captions and render reviewed text', async () => {
  const { window, document } = parseHTML(fs.readFileSync('index.html', 'utf8'));
  const storage = new Map(), drawCalls = [], requests = [];
  const $ = selector => document.querySelector(selector);
  for (const select of document.querySelectorAll('select')) {
    let value = select.querySelector('option')?.getAttribute('value') || '';
    Object.defineProperty(select, 'value', { configurable: true, get: () => value, set: next => { value = String(next); } });
    select.add = option => { select.append(option); if (!value) value = option.value; };
  }
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) checkbox.checked = checkbox.hasAttribute('checked');
  for (const canvas of document.querySelectorAll('canvas')) {
    canvas.width = Number(canvas.getAttribute('width')); canvas.height = Number(canvas.getAttribute('height'));
    canvas.getContext = () => ({ drawImage(...args) { drawCalls.push({ id: canvas.id, args }); }, strokeRect() {}, fillRect() {}, fillText() {}, strokeText() {}, measureText: text => ({ width: text.length * 15 }) });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height });
    canvas.setPointerCapture = () => {};
  }
  const dialog = $('#vertical-dialog'); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  const originalCreate = document.createElement.bind(document);
  document.createElement = name => {
    const element = originalCreate(name);
    if (name === 'video') {
      Object.assign(element, { videoWidth: 640, videoHeight: 360, readyState: 2, duration: 60, paused: true, currentTime: 0 });
      element.pause = () => { element.paused = true; element.dispatchEvent(new window.Event('pause')); };
      element.play = async () => { element.paused = false; };
      element.load = () => queueMicrotask(() => { element.onloadedmetadata?.(); element.dispatchEvent(new window.Event('loadeddata')); });
    }
    return element;
  };
  const fixture = { id: 'original', width: 640, height: 360, duration: 60, hasAudio: true, audioTrackInfo: [{ index: 0, label: 'Micrófono', codec: 'aac' }] };
  const context = vm.createContext({ $, window, document, console, Blob, URL, crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Option: function(text, value) { const option = document.createElement('option'); option.textContent = text; option.value = value; return option; },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout,
    jobs: [], busy: false, selectedFile: { size: 1000 }, state: {}, sourceMedia: null, media: null, objectUrl: 'blob:fixture', posted: false,
    video: { pause() {}, load() {} }, upload: async () => fixture, updateButton() { window.clipEditor?.refresh(); }, displayMetadata() {}, showMessage() {},
    api: async (url, payload) => {
      requests.push({ url, payload });
      if (url === '/api/editor/status') return { installed: true, modelReady: true, template: structuredClone(DEFAULT_TEMPLATE) };
      if (url.endsWith('/transcribe')) return { id: 'test-transcript', status: 'done', message: 'Subtítulos listos', result: { segments: [{ start: 0, end: 1.5, text: 'Hola mundo' }] } };
      if (url.endsWith('/render')) return { id: 'test-render', status: 'done', message: 'Listo', result: { media: { id: 'vertical', size: 1024, url: '/api/media/vertical' }, srt: '1\n00:00:00,000 --> 00:00:01,500\nTexto corregido' } };
      throw new Error('Unexpected route: ' + url);
    }
  });
  vm.runInContext(fs.readFileSync('vertical.js', 'utf8'), context);
  const wait = () => new Promise(resolve => setTimeout(resolve, 10));
  const dispatch = (id, type = 'click') => $(id).dispatchEvent(new window.Event(type));
  dispatch('#open-vertical'); await wait();
  assert.equal(dialog.open, true); assert.equal($('#render-vertical').disabled, true, 'Subtitles must be generated before rendering');
  assert.equal($('#transcribe-button').disabled, false);
  assert.ok(drawCalls.some(call => call.id === 'vertical-canvas'));
  $('#camera-placement').value = 'bottom'; dispatch('#camera-placement', 'input');
  const camera = drawCalls.filter(call => call.id === 'vertical-canvas').at(-2);
  assert.equal(camera.args[6], 720, 'Camera must move to the bottom of the preview');
  $('#crop-target').value = 'game'; dispatch('#crop-target', 'change');
  $('#crop-x').value = '20'; dispatch('#crop-x', 'change'); dispatch('#save-template');
  assert.equal(JSON.parse(storage.get('3wayclip-vertical-template')).game.x, 0.2);
  $('#camera-placement').value = 'overlay'; dispatch('#camera-placement', 'input');
  assert.equal($('#overlay-settings').hidden, false);
  $('#overlay-x').value = '30'; dispatch('#overlay-x', 'change'); dispatch('#save-template');
  assert.equal(JSON.parse(storage.get('3wayclip-vertical-template')).overlay.x, 0.3);
  dispatch('#editor-play'); await wait(); assert.equal($('#editor-play').textContent, 'Pausar vista previa');
  dispatch('#transcribe-button'); await wait();
  assert.equal($('#render-vertical').disabled, false);
  const text = $('#subtitle-rows textarea'); text.value = 'Texto corregido'; text.dispatchEvent(new window.Event('input'));
  $('#clip-start').value = '1'; dispatch('#clip-start', 'change'); assert.equal($('#render-vertical').disabled, true, 'Time changes invalidate old timestamps');
  $('#clip-start').value = '0'; dispatch('#clip-start', 'change'); assert.equal($('#render-vertical').disabled, false);
  dispatch('#render-vertical'); await wait();
  const request = requests.find(request => request.url.endsWith('/render'));
  assert.equal(request.payload.mediaId, 'original'); assert.equal(request.payload.segments[0].text, 'Texto corregido'); assert.equal(request.payload.template.cameraPlacement, 'overlay');
  assert.equal(dialog.open, false); assert.equal(context.media.id, 'vertical'); assert.equal(context.sourceMedia.id, 'original');
  dispatch('#use-original'); assert.equal(context.media.id, 'original');
});
