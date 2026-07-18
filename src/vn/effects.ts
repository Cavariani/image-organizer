// Efeitos de escrita disponíveis por fala + velocidade global (multiplicador salvo em localStorage).
export type FxId = 'type' | 'word' | 'fade' | 'blur';

export interface FxOpt { id: FxId; label: string; }

export const EFFECTS: FxOpt[] = [
  { id: 'type', label: 'Máquina de escrever' },
  { id: 'word', label: 'Palavra por palavra' },
  { id: 'fade', label: 'Fade suave' },
  { id: 'blur', label: 'Desfoque → nítido' },
];

export const DEFAULT_FX: FxId = 'type';

// velocidade global: 1 = normal; >1 mais rápido; <1 mais lento
export function getGlobalSpeed(): number {
  const v = parseFloat(localStorage.getItem('vnSpeed') || '');
  return v > 0 ? v : 1;
}
export function setGlobalSpeed(v: number): void {
  localStorage.setItem('vnSpeed', String(v));
}
