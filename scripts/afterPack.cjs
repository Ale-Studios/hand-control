// After electron-builder has copied Electron into dist\win-unpacked: put OUR icon and version info into the .exe
// (otherwise Windows shows the default Electron logo). Uses the small `rcedit` tool, no certificate or admin rights needed.
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const mod = require('rcedit');
  const rcedit = typeof mod === 'function' ? mod : mod.rcedit || mod.default;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'Hand Control',
      FileDescription: 'Hand Control',
      CompanyName: 'Ale Studios',
      LegalCopyright: 'Copyright Ale Studios',
      OriginalFilename: 'Hand Control.exe',
      InternalName: 'Hand Control',
    },
  });
  console.log('  • icon and version info written into ' + path.basename(exe));
};
