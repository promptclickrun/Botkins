// Keep the original ordering for bots whose default look is derived from their id.
export const originalHeadIds = ["beacon", "crumb", "fathom", "goggle", "luna", "morel", "muse", "oakley", "pearl", "pip", "posy", "pounce", "ramble", "skiff", "spool", "sprig", "tinker", "toast", "wick", "wicket"];
export const HEADS_CAPABILITY = "botkin-heads-v2";
const fullCatalog = "botkin-heads-v3";
export const headCapabilities = [HEADS_CAPABILITY, fullCatalog];

const firstCatalog = [...originalHeadIds, "drip", "orbit", "pebble"];
export const headIds = [...firstCatalog, "brim", "clover", "dune", "gloop", "mallow", "ripple", "wisp"].sort();

/** Build the three picker lists once, preserving the supplied artwork and display order. */
export function makeHeadPicker(heads) {
  const original = heads.filter(head => originalHeadIds.includes(head.id));
  const first = heads.filter(head => firstCatalog.includes(head.id));
  return (capabilities = []) => {
    if (capabilities.includes(fullCatalog)) return heads;
    if (capabilities.includes(HEADS_CAPABILITY)) return first;
    return original;
  };
}
