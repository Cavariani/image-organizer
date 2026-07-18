// Fontes embutidas no bundle (só o subset latino). O vite-plugin-singlefile inlina os .woff2
// como base64 no HTML final, então funcionam offline sem nenhuma requisição externa.
import '@fontsource/eb-garamond/latin-400.css';
import '@fontsource/eb-garamond/latin-600.css';
import '@fontsource/dancing-script/latin-400.css';
import '@fontsource/dancing-script/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';

export interface FontOpt { label: string; css: string; } // css = valor de font-family; '' = herda a UI

export const FONTS: FontOpt[] = [
  { label: 'Padrão', css: '' },
  { label: 'Garamond', css: "'EB Garamond', Georgia, serif" },
  { label: 'Manuscrita', css: "'Dancing Script', cursive" },
  { label: 'Inter', css: "'Inter', system-ui, sans-serif" },
];
