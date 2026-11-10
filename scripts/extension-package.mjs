import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function packagePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || /^(?:[a-z]+:|\/)/i.test(value) || /[?#*]/.test(value)) throw Error('Invalid packaged resource: ' + value);
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) throw Error('Resource escapes extension directory: ' + value);
  return normalized;
}

export function collectExtensionFiles(extensionRoot) {
  const root = path.resolve(extensionRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pending = ['manifest.json'];
  const enqueue = (value, from = '') => { if (value) pending.push(packagePath(path.posix.join(path.posix.dirname(from || '.'), packagePath(value)))); };
  const icons = (value) => typeof value === 'string' ? enqueue(value) : Object.values(value || {}).forEach((name) => enqueue(name));
  icons(manifest.icons);
  icons(manifest.action?.default_icon);
  enqueue(manifest.action?.default_popup);
  enqueue(manifest.background?.service_worker);
  enqueue(manifest.options_page);
  enqueue(manifest.options_ui?.page);
  for (const content of manifest.content_scripts || []) {
    [...(content.js || []), ...(content.css || [])].forEach((name) => enqueue(name));
  }
  for (const group of manifest.web_accessible_resources || []) (group.resources || []).forEach((name) => enqueue(name));
  if (fs.existsSync(path.join(root, 'README.md'))) enqueue('README.md');
  const files = new Map();
  while (pending.length) {
    const name = pending.shift();
    if (files.has(name)) continue;
    const absolute = path.resolve(root, name);
    if (!absolute.startsWith(root + path.sep)) throw Error('Invalid extension resource: ' + name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Extension resources must be regular files: ' + name);
    const bytes = fs.readFileSync(absolute);
    files.set(name, bytes);
    const source = /\.(?:html|js|mjs|css)$/i.test(name) ? bytes.toString('utf8') : '';
    if (/\.html$/i.test(name)) {
      for (const match of source.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) enqueue(match[1], name);
    }
    if (/\.(?:js|mjs)$/i.test(name)) {
      for (const match of source.matchAll(/(?:\bimport\s*(?:[^;\n]*?\sfrom\s*)?|\bexport\s+[^;\n]*?\sfrom\s*)["'](\.[^"']+)["']/g)) enqueue(match[1], name);
      for (const match of source.matchAll(/(?:chrome|browser)\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g)) enqueue(match[1]);
      for (const match of source.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) enqueue(match[1], name);
    }
  }
  return { manifest, files: new Map([...files].sort(([a], [b]) => a.localeCompare(b))) };
}

export function extensionZip(files) {
  const entries = [...files].map(([name, bytes]) => [packagePath(name), Buffer.from(bytes).toString('base64')]);
  return zipTool({ mode: 'pack', entries });
}

function zipTool(input) {
  const command = process.env.BOSS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(command, [path.join(projectRoot, 'scripts', 'zip-package.py')], {
    input: JSON.stringify(input), maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw Error('Python 3 is required for ZIP packaging: ' + (result.error?.message || result.stderr?.toString('utf8') || 'unknown error'));
  }
  return result.stdout;
}

export function inspectExtensionZip(bytes) {
  return new Map(JSON.parse(zipTool({ mode: 'inspect', archive: Buffer.from(bytes).toString('base64') }).toString('utf8'))
    .map(([name, data]) => [name, Buffer.from(data, 'base64')]));
}

export function sourcePackageFiles(root, extensionFiles) {
  const files = new Map([...extensionFiles].map(([name, bytes]) => ['extension/' + name, bytes]));
  for (const name of ['README.md', 'package.json', 'package-lock.json', '.gitignore', '.github/workflows/ci.yml']) {
    files.set(name, fs.readFileSync(path.join(root, name)));
  }
  if (fs.existsSync(path.join(root, 'VALIDATION.md'))) files.set('VALIDATION.md', fs.readFileSync(path.join(root, 'VALIDATION.md')));
  // Keep the selected icon's editable design in the source archive, outside the runtime package.
  for (const name of ['render.html', 'export.py', 'README.md', 'icon512.png']) {
    const relative = 'design/briefcase/' + name;
    if (fs.existsSync(path.join(root, relative))) files.set(relative, fs.readFileSync(path.join(root, relative)));
  }
  for (const relative of ['docs/images/popup.png', 'docs/images/panel.png']) {
    if (fs.existsSync(path.join(root, relative))) files.set(relative, fs.readFileSync(path.join(root, relative)));
  }
  for (const directory of ['scripts', 'tests']) {
    for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (item.isFile() && (item.name.endsWith('.mjs') || directory === 'scripts' && item.name.endsWith('.py'))) {
        files.set(directory + '/' + item.name, fs.readFileSync(path.join(root, directory, item.name)));
      }
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}
