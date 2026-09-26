const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProviders } = require('../lib/providers');

const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
function setup() {
  const data = { providers: Object.fromEntries(['youtube', 'tiktok', 'instagram'].map(id => [id, {
    clientId: 'client', clientSecret: 'secret', redirectUri: `https://app.example/oauth/${id}/callback`, graphVersion: 'v24.0', tiktokMode: 'direct', tiktokLogin: 'web',
    token: { access_token: 'access', refresh_token: 'refresh', expiresAt: Date.now() + 3600000 }, account: { id: '123', name: 'Test' }
  }])) };
  const store = { data, save() {} };
  return { store, providers: createProviders(store) };
}

test('Provider OAuth and publishing protocols with mocked official endpoints (no real posts)', async t => {
  await t.test('Each provider uses its official authorization endpoint and intended scope', () => {
    const { providers, store } = setup();
    const google = new URL(providers.authorization('youtube', 'state').url);
    assert.equal(google.hostname, 'accounts.google.com'); assert.equal(google.searchParams.get('access_type'), 'offline');
    assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
    store.data.providers.tiktok.tiktokLogin = 'desktop';
    const tt = new URL(providers.authorization('tiktok', 'state').url);
    assert.equal(tt.searchParams.get('scope'), 'user.info.basic,video.publish');
    assert.match(tt.searchParams.get('code_challenge'), /^[a-f0-9]{64}$/);
    store.data.providers.tiktok.tiktokMode = 'inbox';
    assert.match(new URL(providers.authorization('tiktok', 'state').url).searchParams.get('scope'), /video.upload/);
    const ig = new URL(providers.authorization('instagram', 'state').url);
    assert.equal(ig.hostname, 'www.instagram.com'); assert.match(ig.searchParams.get('scope'), /instagram_business_content_publish/);
  });
  await t.test('Denied publishing scopes never produce a connected account', async t => {
    const { providers } = setup();
    t.mock.method(global, 'fetch', async () => response({ access_token: 'token', scope: 'user.info.basic', expires_in: 3600 }));
    await assert.rejects(providers.exchange('tiktok', 'code', 'verifier'), /Faltan permisos/);
  });
  await t.test('Expired Google credentials refresh before access and persist rotated tokens', async t => {
    const { store, providers } = setup(); store.data.providers.youtube.token.expiresAt = 0;
    let calls = 0;
    t.mock.method(global, 'fetch', async (url, options) => {
      calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(options.body.get('grant_type'), 'refresh_token');
      return response({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
    });
    assert.deepEqual(await Promise.all([providers.access('youtube'), providers.access('youtube')]), ['new', 'new']);
    assert.equal(calls, 1); assert.equal(store.data.providers.youtube.token.refresh_token, 'rotated');
  });
  await t.test('TikTok chunks trailing bytes correctly and remains processing until confirmed', async t => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data-'));
    const file = path.join(directory, 'video.mp4');
    const size = 22 * 1024 * 1024 + 123;
    const handle = fs.openSync(file, 'w'); fs.ftruncateSync(handle, size); fs.closeSync(handle);
    const { providers } = setup(); const updates = {}; const ranges = [];
    t.mock.method(global, 'fetch', async (url, options) => {
      if (url.includes('creator_info')) return response({ data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 180 }, error: { code: 'ok' } });
      if (url.includes('/video/init/')) {
        const body = JSON.parse(options.body);
        assert.equal(body.source_info.total_chunk_count, 2); assert.equal(body.post_info.privacy_level, 'SELF_ONLY'); assert.equal(body.post_info.disable_comment, true);
        assert.equal(body.post_info.title, 'Texto', 'TikTok gets only the description, not the YouTube title');
        return response({ data: { publish_id: 'tt-id', upload_url: 'https://open-upload.tiktokapis.com/upload/example' }, error: { code: 'ok' } });
      }
      if (url.includes('open-upload')) {
        ranges.push(options.headers['Content-Range']); let received = 0; for await (const chunk of options.body) received += chunk.length;
        assert.equal(received, Number(options.headers['Content-Length'])); return new Response('', { status: 201 });
      }
      if (url.includes('status/fetch')) return response({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } });
      throw new Error('Unexpected endpoint');
    });
    try {
      await providers.publish('tiktok', { file, size, mime: 'video/mp4', duration: 3 }, { title: 'Título', description: 'Texto', tiktokPrivacy: 'SELF_ONLY' }, value => Object.assign(updates, value));
      assert.deepEqual(ranges, [`bytes 0-10485759/${size}`, `bytes 10485760-${size - 1}/${size}`]);
      assert.equal(updates.status, 'processing');
      await providers.check('tiktok', updates, value => Object.assign(updates, value)); assert.equal(updates.status, 'done');
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep + '.test-data-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await t.test('Instagram waits for FINISHED and never repeats an ambiguous media_publish call', async t => {
    const { providers } = setup(); const item = {}; let calls = 0;
    t.mock.method(global, 'fetch', async (url, options) => {
      if (url.endsWith('/123/media')) {
        assert.equal(options.body.get('video_url'), 'https://app.example/media/opaque-token');
        assert.equal(options.body.get('caption'), 'Descripción', 'Instagram gets only the description');
        assert.equal(options.body.has('title'), false);
        return response({ id: 'container' });
      }
      if (url.includes('status_code')) return response({ status_code: 'FINISHED' });
      if (url.endsWith('/media_publish')) { calls++; throw new Error('Network response lost'); }
      throw new Error('Unexpected endpoint');
    });
    const update = value => Object.assign(item, value);
    await providers.publish('instagram', {}, { title: 'Título', description: 'Descripción' }, update, 'https://app.example/media/opaque-token');
    assert.equal(item.status, 'processing'); assert.equal(calls, 0);
    await assert.rejects(providers.check('instagram', item, update)); assert.equal(calls, 1);
    await providers.check('instagram', item, update); assert.equal(calls, 1); assert.equal(item.status, 'uncertain');
  });
  await t.test('YouTube uploads bytes with requested privacy, then checks actual processing and privacy', async t => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-data-'));
    const file = path.join(directory, 'fixture.mp4'); fs.writeFileSync(file, Buffer.from('video-bytes'));
    const { providers } = setup(); const item = {};
    t.mock.method(global, 'fetch', async (url, options) => {
      if (url.includes('uploadType=resumable')) {
        const body = JSON.parse(options.body);
        assert.equal(body.status.privacyStatus, 'unlisted'); assert.equal(body.status.selfDeclaredMadeForKids, false);
        assert.equal(body.snippet.title, 'Test'); assert.equal(body.snippet.description, 'Descripción de YouTube');
        return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/session' } });
      }
      if (url.endsWith('/upload/session')) {
        let content = ''; for await (const chunk of options.body) content += chunk;
        assert.equal(content, 'video-bytes'); assert.equal(options.headers.Authorization, 'Bearer access');
        return response({ id: 'yt-test' });
      }
      if (url.includes('/youtube/v3/videos?')) return response({ items: [{ status: { uploadStatus: 'processed', privacyStatus: 'private' } }] });
      throw new Error('Unexpected endpoint');
    });
    try {
      const update = value => Object.assign(item, value);
      await providers.publish('youtube', { file, size: 11, mime: 'video/mp4' }, { title: 'Test', description: 'Descripción de YouTube', youtubePrivacy: 'unlisted', madeForKids: 'no' }, update);
      assert.equal(item.status, 'processing'); assert.equal(item.remoteId, 'yt-test');
      await providers.check('youtube', item, update); assert.equal(item.status, 'done'); assert.match(item.message, /private/);
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep + '.test-data-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
