// Files handed to a window that can't show a save or an open dialog: a paired phone, or another
// computer using this one (capability "files-v1"). Each call answers the file itself, with a name
// to save it under: { name, text } for text, { name, base64 } for a zip or a PDF. Where the file
// goes is then the person's choice on their own device (a share sheet, a Files picker).
//
//   exportTemplateText, importTemplateText   desktop/templates.mjs
//   exportUsageText                          the usage CSV (desktop/usage.mjs)
//   exportWikiFile                           the wiki export, in the desktop's three formats
//
// A file travels in one answer of the link, so it has a size limit, said in words when it is passed.
export const FILES = "files-v1";
/** The most one file may weigh, in bytes. The link carries 6 MB in a call, and base64 adds a third. */
export const MAX_FILE = 4_000_000;

const megabytes = (bytes) => (bytes / 1_000_000).toFixed(1).replace(/\.0$/, "");

/** A file as an answer: text as it is, anything else as base64. Refused in words when it is too large to send. */
export function fileAnswer(name, data) {
  const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
  if (bytes > MAX_FILE) throw new Error("That file is " + megabytes(bytes) + " MB, and at most " + megabytes(MAX_FILE) + " MB can be sent in one piece. Export less at once, or export it on the computer itself.");
  return typeof data === "string" ? { name, text: data } : { name, base64: Buffer.from(data).toString("base64") };
}

/** The usage report of the last 7, 30 or 90 days as a CSV file. `csv` makes the text (desktop/usage.mjs usageCsv). */
export function usageFile(days, csv) {
  if (![7, 30, 90].includes(days)) throw new Error("Choose 7, 30 or 90 days");
  return fileAnswer("botkins-usage-" + days + "d.csv", csv(days));
}

/** The name a wiki export is saved under, without its ending. */
export const wikiExportName = (title) => (String(title ?? "Wiki").replace(/[\\/:*?"<>|\0-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Wiki") + " wiki export";

/**
 * A wiki export as a file: { format: "zip" | "html" | "pdf", paths, title, everything? }.
 * The document of "html" and "pdf" is laid out here, by the same code the window uses.
 * @param tools.wiki    The wiki (exportFiles, exportPages).
 * @param tools.zip     (files) => Buffer.
 * @param tools.pdf     async (html) => Buffer.
 * @param tools.layout  async () => { exportDocument }, the compiled src/wikiExportDoc.tsx.
 */
export async function wikiFile({ format, paths, title, everything } = {}, { wiki, zip, pdf, layout }) {
  if (!["zip", "html", "pdf"].includes(format)) throw new Error("Choose a format to export.");
  const name = wikiExportName(title);
  if (format === "zip") return fileAnswer(name + ".zip", zip(wiki.exportFiles({ paths, title, everything: everything === true }).map((file) => ({ ...file, path: name + "/" + file.path }))));
  const { exportDocument } = await layout();
  const html = exportDocument({ title: String(title ?? "").trim() || "Wiki", pages: wiki.exportPages(paths) });
  return format === "html" ? fileAnswer(name + ".html", html) : fileAnswer(name + ".pdf", await pdf(html));
}
