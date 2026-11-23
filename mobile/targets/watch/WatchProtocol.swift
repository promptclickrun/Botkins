// The WatchConnectivity shape mirrors the bounded JSON produced by src/features/watch/model.ts.
import Foundation

let watchProtocolVersion = 1

struct WatchSnapshot: Codable {
  let version: Int
  let revision: Int64
  let at: Double
  let computer: WatchComputer?
  let bot: WatchBot?
  let chat: WatchChat?
  let voice: WatchVoice

  enum CodingKeys: String, CodingKey {
    case version = "protocol"
    case revision, at, computer, bot, chat, voice
  }
}

struct WatchComputer: Codable {
  let id: String
  let name: String
  let online: Bool
}

struct WatchLook: Codable {
  let head: String
  let palette: String
  let eyes: String?
  let colors: [String]?
}

struct WatchBot: Codable {
  let id: String
  let name: String
  let role: String
  let look: WatchLook
}

struct WatchChat: Codable {
  let id: String
  let title: String
  let updatedAt: Double
  let activity: String
  let messages: [WatchMessage]
}

struct WatchMessage: Codable, Identifiable {
  let id: String
  let who: String
  let text: String
  let at: Double?
  let final: Bool
}

struct WatchVoice: Codable {
  let status: String
  let sessionId: String?
  let chatId: String?
  let muted: Bool
  let push: Bool
  let problem: String?
  let level: Double

  var active: Bool {
    ["connecting", "listening", "thinking", "talking"].contains(status)
  }

  var label: String {
    switch status {
    case "connecting": return "Connecting..."
    case "listening": return "Listening"
    case "thinking": return "Working on it..."
    case "talking": return "Speaking"
    case "error": return problem ?? "Call failed"
    case "ended": return problem ?? "Call ended"
    default: return "Talk to your Botkin"
    }
  }
}

enum WatchPacketKind: UInt8 {
  case output = 1
  case input = 2
  case flush = 3
}

struct WatchAudioPacket {
  let kind: WatchPacketKind
  let sessionId: String
  let sampleRate: UInt32
  let sequence: UInt32
  let pcm: Data

  func data() -> Data? {
    guard let id = sessionId.data(using: .utf8), id.count <= UInt8.max else { return nil }
    var value = Data([1, kind.rawValue, UInt8(id.count)])
    value.appendUInt32(sampleRate)
    value.appendUInt32(sequence)
    value.append(id)
    value.append(pcm)
    return value
  }

  static func decode(_ data: Data) -> WatchAudioPacket? {
    guard data.count >= 11, data[0] == 1, let kind = WatchPacketKind(rawValue: data[1]) else { return nil }
    let idLength = Int(data[2])
    guard data.count >= 11 + idLength,
          let id = String(data: data.subdata(in: 11..<(11 + idLength)), encoding: .utf8) else { return nil }
    return WatchAudioPacket(
      kind: kind,
      sessionId: id,
      sampleRate: data.uint32(at: 3),
      sequence: data.uint32(at: 7),
      pcm: data.subdata(in: (11 + idLength)..<data.count)
    )
  }
}

private extension Data {
  mutating func appendUInt32(_ value: UInt32) {
    var little = value.littleEndian
    append(Data(bytes: &little, count: 4))
  }

  func uint32(at offset: Int) -> UInt32 {
    guard offset >= 0, offset + 4 <= count else { return 0 }
    return withUnsafeBytes {
      $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
    }
  }
}

extension WatchSnapshot {
  static let empty = WatchSnapshot(
    version: watchProtocolVersion,
    revision: 0,
    at: 0,
    computer: nil,
    bot: nil,
    chat: nil,
    voice: WatchVoice(status: "idle", sessionId: nil, chatId: nil, muted: false, push: false, problem: nil, level: 0)
  )
}
