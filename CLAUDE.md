# ComposerOrganizer

App pessoal de página única para **organizar e reviver** as fotos de um festival de 7 dias
(cada capítulo = um dia). O dono é o único usuário. O objetivo não é produtividade: é montar
uma sequência narrativa/romântica e **revivê-la** do jeito mais imersivo possível.

## O que é / como rodar
- **Um único arquivo:** `organizador.html` (~1900 linhas). HTML + CSS + JS vanilla, **zero dependências, zero build**.
- **Rodar:** abrir o arquivo no **Chrome ou Edge** (precisa da File System Access API; Firefox/Safari não servem).
- **Fluxo:** "Abrir pasta" → ler imagens → classificar em capítulos (Triagem) → ordenar (Sequência) → reviver (Recall) → Exportar.
- **Testar mudança:** abrir o HTML no Chrome e exercitar o modo afetado. Não há testes automatizados nem servidor.

## Arquitetura
- **Estado global `S`** (linha ~350): `{ dir, outDir, images[], chapters[], stats[], mode, active, sel:Set, tIdx, thumb }`.
  - `images[]`: `{ name, chap, order, rej, taken, stats{}, texts[], cardAfter[] }` — `chap=null` é "A definir", `rej=true` é rejeitada.
  - `stats[]` (definições): `{ id, name, emoji, color }`. `im.stats` = `{ statId: contagem }` (quantas vezes aquela foto soma o stat).
  - `im.texts[]` = falas VN sobre a foto; `im.cardAfter[]` = falas de uma tela preta inserida DEPOIS da foto.
  - `chapters[]`: `{ id, name, music? }`.
  - `mode`: `'triage'` | `'sequence'` | `'recall'`.
- **Três modos** (cada um tem seu `render*`):
  - **Triagem** (`renderTriage`): uma foto por vez, atribui a capítulo / rejeita / navega. Ao classificar, pula para a próxima "a definir" (`advanceUnassigned`).
  - **Sequência** (`renderSequence`): grid com drag-and-drop, reordenar por índice (1-based), seleção múltipla, comparar. Por tile: badges de stat (`stx`, popover em `openStatPop`) e botão 💬 de textos (`openTextModal`). Barra de paleta de stats no topo.
  - **Recall** (`renderRecall`, classes CSS `rc*`): **o playback imersivo**. `recallList()` monta os "beats": `{im,ch}` (foto, pode ter Ken Burns + varredura) e `{card,texts,ch}` (tela preta). `rcShow` faz dispatch (`rcShowCard` p/ cartão). Avanço é gated por `RC.statPending` (reveal de stat) e `RC.vnPending` (fala VN em digitação).
- **Stats** (`rcStatsShow`/`rcStatDismiss`/`rcStatsCorner`): ao ganhar pontos, reveal central com `+N` (pausa), depois "pousa" no cantinho acumulando o festival todo.
- **Visual novel** (`rcVN*`): falas digitadas letra por letra; → completa/avança; `H` esconde a caixa. Cartões pretos entre fotos vêm de `im.cardAfter`.
- **Persistência:** IndexedDB (`idbGet`/`idbSet`, store `kv`), chaves `manifest` (por nome de arquivo, com `{chap,order,rej,taken,stats,texts,cardAfter}`), `chapters`, `stats`, `dir`, `outdir`. `save()` é debounced (250ms).
- **Backup portável:** botão "💾 Baixar backup" (`downloadSession`) exporta um `.json` com manifesto+capítulos+stats; "↺ Importar backup" (`importSessionFile`) regrava o idb e reaplica por nome. Único jeito de sobreviver à perda do IndexedDB do Chrome.
- **Trilha:** faixa por capítulo, copiada para `_musica/` dentro da pasta; toca no Recall e faz crossfade na troca de dia.

## Regras que não podem quebrar
- **Nunca tocar nos arquivos originais.** Organização é metadado (manifesto). O export escreve **cópias renumeradas**
  em `_organizado/` (padrão) via `createWritable`; a música vai para `_musica/`.
- **A identidade da imagem é o `name`** (nome do arquivo), não um id. Manifesto, seleção (`S.sel`) e reordenação usam `name`.
- **Persistência é por nome:** reabrir a pasta re-casa o manifesto pelos nomes. Renomear arquivos fora do app perde o estado deles.
- **Reordenar é reinserção 1-based, não swap** (ver `moveToPosition`: remove ANTES de inserir p/ resolver off-by-one).

## Convenções
- **Tudo em PT-BR** (UI, comentários, nomes de capítulo). Manter.
- Tema escuro definido por CSS vars em `:root` (`--bg`, `--panel`, `--acc`, etc.).
- Sem framework: DOM manual via helpers `$`, `el`, `esc`, `uid`, `slug`, `toast`.
- Crossfade de áudio usa `setInterval` de propósito (não rAF), porque rAF congela em aba de fundo e travaria o fade — ver comentário na linha ~1181.
- Capítulos padrão nascem como "Dia 1 · dia", "Dia 1 · noite", ... (ver `defaultChapters`).
