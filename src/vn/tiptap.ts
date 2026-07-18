import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';

// Editor de uma fala: negrito/itálico/sublinhado + cor/fonte/tamanho por trecho.
// Sem blocos de documento (títulos, listas, código) — é diálogo, não artigo.
export function createFalaEditor(element: HTMLElement, content: any): Editor {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: false, codeBlock: false, blockquote: false,
        bulletList: false, orderedList: false, listItem: false,
        horizontalRule: false, code: false, strike: false, link: false,
      } as any),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
    ],
    content: content || { type: 'doc', content: [{ type: 'paragraph' }] },
    autofocus: false,
    editorProps: { attributes: { class: 'falaProse' } },
  });
}
