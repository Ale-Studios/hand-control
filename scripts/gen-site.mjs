// Builds the website (GitHub Pages, served from docs/): docs/index.html from scripts/site-template.html, with the gesture
// icons (the hand skeletons) and the app version filled in. The icon and the screenshots live in docs/assets.
//   node scripts/gen-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../src/renderer/gesture-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let html = fs.readFileSync(path.join(root, 'scripts', 'site-template.html'), 'utf8');
html = html.replaceAll('{{VERSION}}', version).replace(/\{\{ICON:(\w+)\}\}/g, (_, k) => {
  if (!ICONS[k]) throw new Error('unknown icon ' + k);
  return ICONS[k];
});
fs.writeFileSync(path.join(root, 'docs', 'index.html'), html);
console.log('wrote docs/index.html (v' + version + ')');
