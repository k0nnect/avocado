// avocado popup — settings UI backed by chrome.storage.local. Changes propagate
// to live content scripts via storage.onChanged (no message plumbing here).

interface Settings {
  commentary: boolean;
  hoverOnly: boolean;
  multipv: number;
  hashMb: number;
  engineBuild: string;
  safeArrowsOverride: boolean;
}

const DEFAULTS: Settings = {
  commentary: true,
  hoverOnly: false,
  multipv: 3,
  hashMb: 256,
  engineBuild: 'stockfish-18-lite.js',
  safeArrowsOverride: false,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  commentary: $('commentary') as HTMLInputElement,
  hoverOnly: $('hoverOnly') as HTMLInputElement,
  multipv: $('multipv') as HTMLInputElement,
  hashMb: $('hashMb') as HTMLInputElement,
  engineBuild: $('engineBuild') as HTMLSelectElement,
  safeArrowsOverride: $('safeArrowsOverride') as HTMLInputElement,
};
const multipvOut = $('multipvOut') as HTMLOutputElement;
const hashMbOut = $('hashMbOut') as HTMLOutputElement;

/** Reflect the live slider values into their readout chips. */
function syncOutputs(): void {
  multipvOut.textContent = els.multipv.value;
  hashMbOut.textContent = `${els.hashMb.value}mb`;
}

async function load(): Promise<void> {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) } as Settings;
  els.commentary.checked = s.commentary;
  els.hoverOnly.checked = s.hoverOnly;
  els.multipv.value = String(s.multipv);
  els.hashMb.value = String(s.hashMb);
  els.engineBuild.value = s.engineBuild;
  els.safeArrowsOverride.checked = s.safeArrowsOverride;
  syncOutputs();
}

function read(): Settings {
  return {
    commentary: els.commentary.checked,
    hoverOnly: els.hoverOnly.checked,
    multipv: clamp(parseInt(els.multipv.value, 10), 1, 4, 3),
    hashMb: clamp(parseInt(els.hashMb.value, 10), 16, 1024, 256),
    engineBuild: els.engineBuild.value,
    safeArrowsOverride: els.safeArrowsOverride.checked,
  };
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

async function save(): Promise<void> {
  await chrome.storage.local.set(read());
}

// live slider readouts update on every drag, not just on release
els.multipv.addEventListener('input', syncOutputs);
els.hashMb.addEventListener('input', syncOutputs);

for (const el of Object.values(els)) {
  el.addEventListener('change', save);
}

// export / import (A.C.A.S-style portable config) via a download + file input.
$('export').addEventListener('click', async () => {
  const data = JSON.stringify(await chrome.storage.local.get(DEFAULTS), null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'avocado-settings.json';
  a.click();
  URL.revokeObjectURL(url);
});

$('import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      await chrome.storage.local.set({ ...DEFAULTS, ...parsed });
      await load();
    } catch {
      /* ignore malformed import */
    }
  });
  input.click();
});

load();
