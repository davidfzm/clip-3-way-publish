const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) { console.error('No se pudo preparar la transcripción local. Comprueba Python 3.10+ y la conexión a Internet.'); process.exit(1); }
}
if (!fs.existsSync(python)) run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', '.venv']);
run(python, ['-m', 'pip', 'install', '-r', 'scripts/requirements-subtitles.txt']);
run(python, ['scripts/transcribe.py', '--model-dir', path.join(root, '.data/models/base'), '--download']);
console.log('Subtítulos locales preparados. No se envía audio a servicios externos.');
