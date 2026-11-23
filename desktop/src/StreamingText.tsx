// A reply that is still arriving. Its finished Markdown blocks render once and are kept; only the
// open last block is parsed again on each tick (src/markdownBlocks.ts says where the blocks end).
import { memo, useMemo } from "react";
import { RichBody } from "./RichText";
import { streamBlocks } from "./markdownBlocks";
import type { ChatFiles } from "./ChatFileLink";

export const StreamingText = memo(function StreamingText({ text, files }: { text: string; files?: ChatFiles }) {
  const blocks = useMemo(() => streamBlocks(text), [text]);
  // The blocks sit side by side in one box, so the page's spacing between a box's rows holds.
  return (
    <div className="md">
      {blocks.map((block, index) => block ? <RichBody key={index} text={block} files={files} /> : null)}
    </div>
  );
});
