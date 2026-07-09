import type { AwvSession } from '../shared/schema';

let toastTimer: number | null = null;
export function toast(msg: string) {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast'; el.className = 'toast';
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
  document.querySelector('.stage')!.append(el);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.remove(); toastTimer = null; }, 4000);
}

function parseAwv(text: string, label: string): AwvSession {
  const obj = JSON.parse(text) as AwvSession;
  if (!Array.isArray(obj.agents) || !Array.isArray(obj.events)) throw new Error('JSON needs agents and events arrays');
  return { name: obj.name || 'Imported replay', desc: obj.desc || label, agents: obj.agents, events: obj.events };
}

export function exportSession(awv: AwvSession) {
  const blob = new Blob([JSON.stringify(awv, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${awv.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'claude-session'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Wires the file input, window drag-and-drop, and JSON paste to `onAwv`. */
export function setupImport(fileInput: HTMLInputElement, dropOverlay: HTMLElement, onAwv: (awv: AwvSession) => void) {
  const importFile = (f: File) => f.text()
    .then(text => onAwv(parseAwv(text, f.name)))
    .catch(err => toast(`Import failed: ${err.message || err}`));

  fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) importFile(f); };

  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) dropOverlay.hidden = true; });
  window.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0; dropOverlay.hidden = true;
    const f = e.dataTransfer?.files?.[0]; if (f) importFile(f);
  });
  window.addEventListener('paste', e => {
    const tag = (e.target as HTMLElement)?.tagName || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (!text || !(text.startsWith('{') || text.startsWith('['))) return;
    try { onAwv(parseAwv(text, 'Pasted replay')); } catch (err) { toast(`Import failed: ${(err as Error).message || err}`); }
  });
}
