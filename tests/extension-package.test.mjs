import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExtensionFiles, extensionZip, inspectExtensionZip, projectRoot } from '../scripts/extension-package.mjs';

function fixture(t, mutate = () => {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'boss-extension-package-test-'));
  t.after(() => {
    if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('boss-extension-package-test-')) throw Error('Invalid test cleanup directory');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifest = {
    manifest_version: 3, version: '1.1.0', name: 'Fixture', permissions: ['storage'],
    background: { service_worker: 'background.js' },
    content_scripts: [{ matches: ['https://www.zhipin.com/*'], js: ['platform.js', 'helper.js', 'content.js'] }],
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } },
  };
  for (const name of ['background.js', 'platform.js', 'helper.js', 'content.js', 'popup.js']) fs.writeFileSync(path.join(root, name), '// local fixture\n');
  fs.mkdirSync(path.join(root, 'icons'));
  fs.writeFileSync(path.join(root, 'icons/icon16.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(root, 'popup.html'), '<link rel="stylesheet" href="popup.css"><script src="popup.js"></script>');
  fs.writeFileSync(path.join(root, 'popup.css'), 'body { color: blue; }');
  fs.writeFileSync(path.join(root, 'README.md'), 'Load unpacked.');
  mutate(manifest, root);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

test('extension archive includes manifest-referenced scripts, popup assets and instructions, excluding private files', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'credentials.json'), '{"key":"private-fixture"}');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=private-fixture');
  const { files } = collectExtensionFiles(root);
  const unpacked = inspectExtensionZip(extensionZip(files));
  for (const name of ['manifest.json', 'background.js', 'helper.js', 'platform.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons/icon16.png', 'README.md']) {
    assert.ok(unpacked.has(name), name + ' must survive packaging');
    assert.deepEqual(unpacked.get(name), fs.readFileSync(path.join(root, name)));
  }
  assert.equal(unpacked.has('credentials.json'), false);
  assert.equal(unpacked.has('.env'), false);
});

test('a missing runtime resource stops packaging instead of producing a broken extension', (t) => {
  const root = fixture(t, (_manifest, root) => fs.unlinkSync(path.join(root, 'popup.js')));
  assert.throws(() => collectExtensionFiles(root), /ENOENT/);
});

test('ZIP packaging preserves Chinese filenames and content regardless of Windows console encoding', () => {
  const content = Buffer.from('配置说明：无需油猴。', 'utf8');
  const archive = extensionZip(new Map([['中文说明.md', content]]));
  const unpacked = inspectExtensionZip(archive);
  assert.deepEqual(unpacked.get('中文说明.md'), content);
});

test('resource paths cannot escape the extension directory', (t) => {
  const root = fixture(t, (manifest) => { manifest.background.service_worker = '../outside.js'; });
  assert.throws(() => collectExtensionFiles(root), /escapes extension directory/);
});

test('remote popup scripts are rejected rather than copied into a Manifest V3 package', (t) => {
  const root = fixture(t, (_manifest, root) => fs.writeFileSync(path.join(root, 'popup.html'), '<script src="https://example.com/code.js"></script>'));
  assert.throws(() => collectExtensionFiles(root), /Invalid packaged resource/);
});

test('real extension runtime package contains no userscript, tests, dependencies or personal state', () => {
  const { manifest, files } = collectExtensionFiles(path.join(projectRoot, 'extension'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(files.has('manifest.json'));
  assert.ok(files.has(manifest.background.service_worker));
  assert.ok(files.has('helper.js'));
  assert.ok(files.has('platform.js'));
  for (const name of files.keys()) assert.doesNotMatch(name, /(?:\.user\.js$|^tests\/|^node_modules\/|\.env$|credentials|\.workbuddy|profile)/i);
});
