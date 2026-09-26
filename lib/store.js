const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = fs.readFileSync(keyPath);
  const file = path.join(directory, 'credentials.enc');
  let data = { providers: {} };
  if (fs.existsSync(file)) {
    const packed = fs.readFileSync(file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    data = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]));
  }
  function save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    fs.writeFileSync(file + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  return { data, save, directory };
}
module.exports = { createStore };
