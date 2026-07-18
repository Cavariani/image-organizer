import { getGlobalSpeed, FxId } from './effects';

// Uma fala rica: doc TipTap (ProseMirror JSON) + efeito de escrita + velocidade própria (opcional).
export interface Fala { doc: any; fx: FxId; speed?: number | null; }

// aceita fala legada (string simples salva antes do editor rico) e converte
export function normalizeFala(f: any): Fala {
  if (typeof f === 'string') {
    return { doc: { type: 'doc', content: [{ type: 'paragraph', content: f ? [{ type: 'text', text: f }] : [] }] }, fx: 'type', speed: null };
  }
  return { doc: f?.doc || { type: 'doc', content: [] }, fx: f?.fx || 'type', speed: f?.speed ?? null };
}

// texto puro de uma fala (para badges/prévias curtas na tela Sequenciar)
export function falaPlain(f: any): string {
  const fala = normalizeFala(f);
  let out = '';
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.type === 'text') out += n.text || '';
      else if (n.type === 'hardBreak') out += ' ';
      else if (n.content) walk(n.content);
    }
    out += ' ';
  };
  walk(fala.doc?.content || []);
  return out.replace(/\s+/g, ' ').trim();
}

interface RunStyle { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; font?: string; size?: string; }
interface Run { text: string; style: RunStyle; }
interface Line { runs: Run[]; }

function marksToStyle(marks: any[]): RunStyle {
  const s: RunStyle = {};
  for (const m of marks || []) {
    if (m.type === 'bold') s.bold = true;
    else if (m.type === 'italic') s.italic = true;
    else if (m.type === 'underline') s.underline = true;
    else if (m.type === 'textStyle') {
      const a = m.attrs || {};
      if (a.color) s.color = a.color;
      if (a.fontFamily) s.font = a.fontFamily;
      if (a.fontSize) s.size = a.fontSize;
    }
  }
  return s;
}

function docToLines(doc: any): Line[] {
  const lines: Line[] = [];
  for (const p of doc?.content || []) {
    const runs: Run[] = [];
    const walk = (nodes: any[]) => {
      for (const n of nodes || []) {
        if (n.type === 'text') runs.push({ text: n.text || '', style: marksToStyle(n.marks) });
        else if (n.type === 'hardBreak') runs.push({ text: '\n', style: {} });
        else if (n.content) walk(n.content);
      }
    };
    walk(p.content);
    lines.push({ runs });
  }
  if (!lines.length) lines.push({ runs: [] });
  return lines;
}

function styleCss(s: RunStyle): string {
  let c = '';
  if (s.bold) c += 'font-weight:700;';
  if (s.italic) c += 'font-style:italic;';
  if (s.underline) c += 'text-decoration:underline;';
  if (s.color) c += `color:${s.color};`;
  if (s.font) c += `font-family:${s.font};`;
  if (s.size) c += `font-size:${s.size};`;
  return c;
}

interface Step { chars: HTMLElement[]; delay: number; }

export interface FalaController { complete(): void; destroy(): void; readonly done: boolean; }

// Monta a fala em `box` com cada caractere num <span.ch> escondido, e revela em passos conforme o
// efeito: 'type' = letra a letra; os demais = palavra a palavra (o CSS .fx-* dá o fade/blur).
export function renderFala(box: HTMLElement, fala: Fala, onDone: () => void): FalaController {
  box.innerHTML = '';
  const speed = (getGlobalSpeed() * (fala.speed || 1)) || 1;
  const fx = fala.fx || 'type';
  const lines = docToLines(fala.doc);
  const allChars: HTMLElement[] = [];

  lines.forEach((line, li) => {
    if (li > 0) box.appendChild(document.createElement('br'));
    const lineEl = document.createElement('span');
    lineEl.className = 'vnLine';
    for (const run of line.runs) {
      const runEl = document.createElement('span');
      runEl.className = 'vnRun';
      runEl.style.cssText = styleCss(run.style);
      for (const chr of Array.from(run.text)) {
        if (chr === '\n') { runEl.appendChild(document.createElement('br')); continue; }
        const ce = document.createElement('span');
        ce.className = 'ch fx-' + fx;
        ce.textContent = chr;
        runEl.appendChild(ce);
        allChars.push(ce);
      }
      lineEl.appendChild(runEl);
    }
    box.appendChild(lineEl);
  });

  const steps: Step[] = [];
  const base = fx === 'type' ? 26 : 95; // ms por unidade na velocidade 1
  if (fx === 'type') {
    for (const ce of allChars) {
      const c = ce.textContent || '';
      const mult = /[.!?…]/.test(c) ? 9 : /[,;:—–]/.test(c) ? 5 : 1;
      steps.push({ chars: [ce], delay: (mult * base) / speed });
    }
  } else {
    let group: HTMLElement[] = [];
    const flush = () => { if (group.length) { steps.push({ chars: group, delay: base / speed }); group = []; } };
    for (const ce of allChars) { group.push(ce); if ((ce.textContent || '') === ' ') flush(); }
    flush();
  }

  let i = 0, timer: any = 0, done = false;
  const reveal = (s: Step) => { for (const c of s.chars) c.classList.add('on'); };
  const finish = () => { if (done) return; done = true; clearTimeout(timer); onDone && onDone(); };
  const tick = () => { if (i >= steps.length) { finish(); return; } const s = steps[i++]; reveal(s); timer = setTimeout(tick, s.delay); };
  const complete = () => { clearTimeout(timer); while (i < steps.length) reveal(steps[i++]); finish(); };
  if (steps.length) tick(); else finish();

  return { complete, destroy() { clearTimeout(timer); }, get done() { return done; } };
}
