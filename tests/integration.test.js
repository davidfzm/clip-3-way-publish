const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../server');
const { run, probe } = require('../lib/media');
const { createStore } = require('../lib/store');
const { createProviders } = require('../lib/providers');

test('Local API, OAuth session binding, secrets, audio conversion, range requests and duplicate-safe publishing', async t => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data-'));
  let publications = 0;
  const app = createApp({ directory, port: 0, providersFactory: store => ({
    ...createProviders(store),
    async exchange(id) { store.data.providers[id].token = { access_token: 'TEST_ACCESS_TOKEN', expiresAt: Date.now() + 3600000 }; store.data.providers[id].account = { name: 'Canal de prueba', id: 'test' }; store.save(); },
    async publish(id, entry, input, update) { publications++; if (id === 'tiktok') throw new Error('Fallo de prueba de TikTok'); update({ status: 'processing', remoteId: 'video-test' }); },
    async check(id, result, update) { update({ status: 'done', message: 'Publicado en la prueba' }); }
  }) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  async function call(route, data, overrides = {}) {
    const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }), ...overrides.headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')) });
    return response;
  }
  try {
    await t.test('Session bootstrap; public requests and CSRF are denied', async () => {
      assert.equal((await call('/api/jobs/nope')).status, 401);
      const response = await call('/api/state'); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf;
      assert.ok(csrf);
      assert.equal((await call('/api/state', undefined, { headers: { Host: 'public.example', 'X-Forwarded-For': '8.8.8.8' } })).status, 403);
      assert.equal((await call('/api/settings/public', { publicOrigin: '' }, { headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
      assert.equal((await call('/api/settings/public', { publicOrigin: '' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    });
    await t.test('Credentials are encrypted and never returned by the API', async () => {
      const result = await call('/api/settings/youtube', { clientId: 'client-test', clientSecret: 'TOP_SECRET_TEST_VALUE', redirectUri: 'https://callbacks.example/oauth/youtube/callback' });
      assert.equal(result.status, 200, await result.text());
      const state = await (await call('/api/state')).text(); assert.ok(!state.includes('TOP_SECRET_TEST_VALUE'));
      assert.ok(!fs.readFileSync(path.join(directory, 'credentials.enc')).includes(Buffer.from('TOP_SECRET_TEST_VALUE')));
      assert.equal(createStore(directory).data.providers.youtube.clientSecret, 'TOP_SECRET_TEST_VALUE');
      assert.equal((await call('/.data/credentials.enc')).status, 404);
    });
    await t.test('OAuth validates state, binds the initiating browser, and consumes the callback once', async () => {
      const auth = await (await call('/api/connect/youtube', {})).json();
      const target = new URL(auth.url); assert.equal(target.hostname, 'accounts.google.com'); assert.ok(target.searchParams.get('code_challenge'));
      assert.equal((await call('/oauth/youtube/callback?state=bad&code=code')).status, 400);
      const callback = `/oauth/youtube/callback?state=${target.searchParams.get('state')}&code=code`;
      const response = await call(callback, undefined, { headers: { Host: 'callbacks.example', 'X-Forwarded-For': '8.8.8.8' } });
      assert.equal(response.status, 302);
      const finish = new URL(response.headers.get('location')).pathname + new URL(response.headers.get('location')).search;
      assert.equal((await call(finish, undefined, { headers: { Cookie: '' } })).status, 403);
      assert.equal((await call(finish)).status, 302);
      assert.equal((await call(finish)).status, 403);
      assert.equal((await call(callback)).status, 400);
      const state = await (await call('/api/state')).text(); assert.ok(!state.includes('TEST_ACCESS_TOKEN')); assert.ok(JSON.parse(state).providers.youtube.connected);
    });
    let media;
    await t.test('Optional conversion produces H.264/AAC and preserves audible audio', async () => {
      const fixture = path.join(directory, 'fixture.mov');
      await run(require('ffmpeg-static'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'pcm_s16le', '-shortest', fixture]);
      const original = await probe(fixture); assert.equal(original.audioCodec, 'pcm_s16le');
      const response = await call('/api/uploads', undefined, { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'video/quicktime' }, body: fs.readFileSync(fixture) });
      assert.equal(response.status, 201, response.status === 201 ? '' : await response.text());
      const uploaded = await response.json();
      const conversion = await call(`/api/uploads/${uploaded.id}/convert`, {}); assert.equal(conversion.status, 200, conversion.status === 200 ? '' : await conversion.text());
      media = await conversion.json(); assert.equal(media.audioCodec, 'aac'); assert.equal(media.videoCodec, 'h264'); assert.equal(media.hasAudio, true); assert.equal(media.audioUrl, undefined);
      const decoded = path.join(directory, 'decoded.wav');
      await run(require('ffmpeg-static'), ['-y', '-v', 'error', '-i', app.media.entries.get(media.id).file, '-vn', '-c:a', 'pcm_s16le', decoded]);
      const wav = fs.readFileSync(decoded);
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      const offset = wav.indexOf(Buffer.from('data')) + 8;
      let peak = 0; for (let index = offset; index < wav.length - 2; index += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(index)));
      assert.ok(peak > 100, 'Converted MP4 must retain audible samples');
      const range = await call(media.url, undefined, { headers: { Range: 'bytes=0-99' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
      assert.equal((await call(media.url, undefined, { headers: { Range: 'bytes=999999999-' } })).status, 416);
    });
    await t.test('Invalid media is rejected; videos without an audio track are identified', async () => {
      assert.equal((await call('/api/uploads', undefined, { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'video/mp4' }, body: 'not a video' })).status, 400);
      const silent = path.join(directory, 'silent.mp4');
      await run(require('ffmpeg-static'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=180x320:d=1', '-c:v', 'libx264', '-an', silent]);
      assert.equal((await probe(silent)).hasAudio, false);
    });
    await t.test('Publish validates options, prevents duplicates, and isolates failures by network', async () => {
      const payload = { requestId: crypto.randomUUID(), mediaId: media.id, title: 'Prueba', description: 'a'.repeat(2200), platforms: ['youtube'], youtubePrivacy: 'private', madeForKids: 'no' };
      assert.equal((await call('/api/publish', { ...payload, title: '' })).status, 400);
      assert.equal((await call('/api/publish', { ...payload, description: '漢'.repeat(1700) })).status, 400, 'YouTube counts UTF-8 bytes, not just characters');
      assert.equal((await call('/api/publish', { ...payload, description: '<texto>' })).status, 400);
      app.store.data.providers.tiktok = { token: { access_token: 'fake' }, tiktokMode: 'inbox', account: { name: 'Cuenta de prueba' } };
      payload.platforms.push('tiktok');
      const first = await call('/api/publish', payload); assert.equal(first.status, 202);
      const again = await call('/api/publish', payload); assert.equal(again.status, 200);
      assert.equal(publications, 2, 'One call per destination despite duplicate HTTP submission');
      const job = await (await call(`/api/jobs/${payload.requestId}/refresh`, {})).json();
      assert.equal(job.results.youtube.status, 'done'); assert.equal(job.results.tiktok.status, 'error');
      const captionOnly = await call('/api/publish', { ...payload, requestId: crypto.randomUUID(), platforms: ['tiktok'], title: '', description: 'Texto sin título' });
      assert.equal(captionOnly.status, 202, 'TikTok does not require a separate title');
    });
  } finally {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(process.cwd()) + path.sep + '.test-data-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
