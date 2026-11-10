import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectExtensionFiles, projectRoot } from './extension-package.mjs';

const root = path.join(projectRoot, 'extension');
const { manifest, files } = collectExtensionFiles(root);
const failures = [];
if (manifest.manifest_version !== 3) failures.push('Manifest V3 is required');
if (!manifest.background?.service_worker) failures.push('Native background service worker is required');
if (!manifest.permissions?.includes('storage')) failures.push('Native storage permission is required');
if (!manifest.action?.default_popup) failures.push('The extension action must provide a popup');
if ((manifest.host_permissions || []).some((host) => !/^https:\/\/www\.zhipin\.(?:com|cn)\/\*$/.test(host))) {
  failures.push('Persistent host permissions must be limited to BOSS; AI origins should be optional');
}
if ((manifest.content_scripts || []).some((content) => content.world === 'MAIN' || content.all_frames === true)) {
  failures.push('Assistant scripts must run in the isolated top-level content world');
}
if (!manifest.content_scripts?.length) failures.push('At least one content script is required');
for (const [name, bytes] of files) {
  if (/\.(?:js|mjs)$/.test(name)) {
    const check = spawnSync(process.execPath, ['--check', path.join(root, name)], { encoding: 'utf8' });
    if (check.status !== 0) failures.push(`${name}: ${check.stderr.trim()}`);
  }
  if (name.endsWith('.html')) {
    const html = bytes.toString('utf8');
    if (/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) failures.push(`${name}: inline scripts are not allowed by MV3 CSP`);
    if (/\bon[a-z]+\s*=/i.test(html)) failures.push(`${name}: inline event handlers are not allowed by MV3 CSP`);
  }
}
const legacySource = path.join(projectRoot, 'BOSS直聘 海投助手（AI版）-1.0.24.user.js');
if (fs.existsSync(legacySource)) {
  const legacyCheck = spawnSync(process.execPath, ['--check', legacySource], { encoding: 'utf8' });
  if (legacyCheck.status !== 0) failures.push('Legacy source syntax: ' + legacyCheck.stderr.trim());
}
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) failures.push('Package and extension versions differ');
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`Manifest V3 and ${files.size} packaged resources verified`);
