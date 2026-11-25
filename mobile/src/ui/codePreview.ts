export const FOLD_LINES = 30;

export type CodePreview = { text: string; lineCount: number; previewEnd: number };

/** Count new line breaks as code arrives. The cursor also bounds the collapsed preview while
 * expanded text and the clipboard still receive the complete block. A revised prefix starts over. */
export function codePreview(code: string, previous?: CodePreview): CodePreview {
  const text = code.endsWith("\n") ? code.slice(0, -1) : code;
  const held = previous && text.startsWith(previous.text) ? previous : undefined;
  let lineCount = held?.lineCount ?? 1;
  let previewEnd = held?.previewEnd ?? -1;
  for (let i = text.indexOf("\n", held?.text.length ?? 0); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (lineCount === FOLD_LINES) previewEnd = i;
    lineCount++;
  }
  return { text, lineCount, previewEnd };
}
