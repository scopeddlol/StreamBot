import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
function run(args, folder = root) {
  const result = spawnSync(process.execPath, args, { cwd: folder, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (result.status !== 0) process.exit(result.status || 1);
}
// Explicitly reviewed native steps; never trust all dependency lifecycle scripts.
// No compiler/fallback npm install is allowed for datachannel: require its prebuild.
const datachannel = path.join(root, 'node_modules/@lng2004/node-datachannel');
if (!existsSync(path.join(datachannel, 'build/Release/node_datachannel.node'))) {
  run([path.join(root, 'node_modules/prebuild-install/bin.js'), '-r', 'napi'], datachannel);
}
const platform = path.join(root, `node_modules/@seydx/node-av-${process.platform}-${process.arch}`);
if (!existsSync(platform)) throw new Error('No supported node-av platform package (Linux/macOS x64/arm64 required)');
run([path.join(platform, 'install.js')]);
run([path.join(root, 'node_modules/node-av/install/check.js')]);
run([path.join(root, 'node_modules/node-av/dist/ffmpeg/install.js')]);
