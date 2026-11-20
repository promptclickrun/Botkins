// QR codes for the pairing link, drawn from the vendored generator (vendor/qrcode.mjs, MIT).
import qrcode from "./vendor/qrcode.mjs";

/** The modules of a QR code: { size, dark(row, column) }. */
export function qrModules(text, level = "M") {
  const qr = qrcode(0, level);
  qr.addData(text, "Byte");
  qr.make();
  return { size: qr.getModuleCount(), dark: (row, column) => qr.isDark(row, column) };
}

/** The code as one SVG path in a square of `size` units (quiet zone included), for a page that draws its own <svg>. */
export function qrPath(text, { margin = 3, level = "M" } = {}) {
  const { size, dark: isDark } = qrModules(text, level);
  let d = "";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (!isDark(row, column)) continue;
      let run = 1;
      while (column + run < size && isDark(row, column + run)) run++;
      d += "M" + (column + margin) + " " + (row + margin) + "h" + run + "v1h-" + run + "z";
      column += run - 1;
    }
  }
  return { size: size + margin * 2, d };
}

/** An SVG of the code with a quiet zone around it. Colors are plain so it prints on any page. */
export function qrSvg(text, { margin = 3, dark = "#1A1420", light = "#FFFFFF", level = "M" } = {}) {
  const { size, dark: isDark } = qrModules(text, level);
  const full = size + margin * 2;
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (!isDark(row, column)) continue;
      let run = 1;
      while (column + run < size && isDark(row, column + run)) run++;
      path += "M" + (column + margin) + " " + (row + margin) + "h" + run + "v1h-" + run + "z";
      column += run - 1;
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + " " + full + '" shape-rendering="crispEdges">' +
    '<rect width="' + full + '" height="' + full + '" fill="' + light + '"/><path d="' + path + '" fill="' + dark + '"/></svg>'
  );
}

/** The code as text for a terminal: two modules per line of half blocks, dark on light. */
export function qrText(text, level = "L") {
  const { size, dark } = qrModules(text, level);
  const at = (row, column) => row >= 0 && row < size && column >= 0 && column < size && dark(row, column);
  const lines = [];
  for (let row = -2; row < size + 2; row += 2) {
    let line = "";
    for (let column = -2; column < size + 2; column++) {
      const top = at(row, column);
      const bottom = at(row + 1, column);
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
