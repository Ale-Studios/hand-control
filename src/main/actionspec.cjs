// Action texts ("keys:<ctrl>+s", "zoom:in", "open:notepad"...) → checked, structured actions. Pure: no Electron needed.
const { parseCombo, MEDIA } = require('./input.cjs');

function parseAction(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === 'none' || t === 'launcher') return { kind: t };
  const i = t.indexOf(':');
  const kind = i < 0 ? '' : t.slice(0, i);
  const value = i < 0 ? '' : t.slice(i + 1).trim();
  if (kind === 'keys') { const vks = parseCombo(value); return vks ? { kind, value, vks } : { error: `Unknown key in "${t}"` }; }
  if (kind === 'zoom') return value === 'in' || value === 'out' ? { kind, value } : { error: `zoom: must be "in" or "out" (${t})` };
  if (kind === 'media') return MEDIA[value.toLowerCase()] ? { kind, value: value.toLowerCase() } : { error: `Unknown media key in "${t}"` };
  if (kind === 'window') return value === 'minimize' || value === 'maximize' ? { kind, value } : { error: `window: must be "minimize" or "maximize" (${t})` };
  if (kind === 'open' && value) return { kind, value };
  return { error: `Not a valid action: "${t}"` };
}

module.exports = { parseAction };
