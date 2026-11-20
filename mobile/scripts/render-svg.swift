// Renders an SVG to a square PNG: swift scripts/render-svg.swift in.svg out.png 1024 [opaque]
import AppKit
let args = CommandLine.arguments
let src = URL(fileURLWithPath: args[1]); let dst = URL(fileURLWithPath: args[2]); let size = Int(args[3]) ?? 1024
let opaque = args.count > 4 && args[4] == "opaque"
guard let image = NSImage(contentsOf: src) else { fatalError("cannot read svg") }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: opaque ? 3 : 4, hasAlpha: !opaque, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: dst)
