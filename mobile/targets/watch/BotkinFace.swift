// The same head/eye geometry used by the iOS Live Activity, generated into the Watch target so the
// Watch never needs React Native or remote image assets.
import SwiftUI

struct BotkinFace: View {
  let look: WatchLook
  var size: CGFloat = 64
  var talking = false

  var body: some View {
    let palette = look.palette == "custom" ? "original" : look.palette
    let head = watchHeads[look.head] ?? watchHeads["sprig"]!
    let ink = Color(hex: look.colors?.last ?? (watchPaletteInk[palette] ?? head.ink))
    ZStack {
      Image("\(look.head)-\(palette)")
        .resizable()
        .interpolation(.high)
        .scaledToFit()
      Canvas { context, canvas in
        let unit = canvas.width / 256
        let place: (Double, Double) -> CGPoint = { x, y in
          CGPoint(x: (head.tx + head.scale * x) * unit, y: (head.ty + head.scale * y) * unit)
        }
        let scale = head.scale * unit
        let style = look.eyes ?? "oval"
        for (index, x) in [head.left, head.right].enumerated() {
          if style == "smile" || style == "sleepy" || (style == "wink" && index == 1) {
            var path = Path()
            path.move(to: place(x - 9, head.y + 3))
            path.addQuadCurve(
              to: place(x + 9, head.y + 3),
              control: place(x, head.y + 3 + (style == "sleepy" ? 7 : -11))
            )
            context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: max(1.2, 5.5 * scale), lineCap: .round))
          } else {
            let ry = style == "button" ? 8.5 : (style == "curious" && index == 1 ? 12 : 17)
            let center = place(x, style == "curious" && index == 0 ? head.y - 3 : head.y)
            let rect = CGRect(
              x: center.x - 8.5 * scale,
              y: center.y - ry * scale,
              width: 17 * scale,
              height: 2 * ry * scale
            )
            context.fill(Path(ellipseIn: rect), with: .color(ink))
          }
        }
      }
    }
    .frame(width: size, height: size)
    .scaleEffect(talking ? 1.04 : 1)
    .animation(.easeInOut(duration: 0.18), value: talking)
    .accessibilityHidden(true)
  }
}

extension Color {
  init(hex: String) {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    self.init(
      red: Double((value >> 16) & 0xff) / 255,
      green: Double((value >> 8) & 0xff) / 255,
      blue: Double(value & 0xff) / 255
    )
  }
}
