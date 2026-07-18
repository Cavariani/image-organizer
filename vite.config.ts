import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// O build gera UM único dist/index.html self-contained (JS+CSS inline) — abre e funciona offline,
// como o organizador.html original. O dev (npm run dev) usa módulos e hot-reload.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100000000, // inlina qualquer asset (fontes, etc.) no HTML final
  },
});
