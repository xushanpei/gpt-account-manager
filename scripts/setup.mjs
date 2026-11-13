import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('需要 Node.js 20 或更新版本，请安装后重新运行。');
  process.exit(1);
}
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(command === 'uv' && result.error?.code === 'ENOENT' ? '未找到 uv，请按 README 安装 uv 后再运行 npm run setup。' : '依赖安装失败，请检查上方错误后重试。');
    process.exit(1);
  }
}
if (!fs.existsSync(python)) run('uv', ['venv', '.venv', '--python', '3.12']);
run('uv', ['pip', 'install', '--python', python, '-r', 'protocol/requirements.txt']);
console.log('依赖已安装，运行 npm start 启动，访问 http://127.0.0.1:4317');
