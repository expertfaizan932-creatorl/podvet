'use strict';

// The handlers do require('electron'), but the real electron package is only
// allowed in devDependencies (electron-builder enforces that) and the web
// edition never runs a Chromium process at all. So we materialise the local
// pure-Node compat shim into node_modules on every install instead of listing
// it as a dependency: `node index.js` (web) resolves require('electron') to
// this copy, while the packaged desktop app resolves it to Electron's builtin
// module long before node_modules is consulted.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function installShim(sourceRel, moduleName) {
  const source = path.join(root, sourceRel);
  const target = path.join(root, 'node_modules', moduleName);
  if (!fs.existsSync(source)) {
    console.error(`link-compat: missing ${sourceRel}, skipping`);
    return;
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch (_) { /* not there yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

installShim('compat/electron-compat', 'electron');
console.log('link-compat: node_modules/electron -> compat/electron-compat');
