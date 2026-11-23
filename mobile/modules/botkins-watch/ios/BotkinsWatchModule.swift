// iPhone's side of the companion Watch. WCSession carries bounded display state, commands and
// short PCM16 frames; provider sessions and pairing credentials remain in this process.
import ExpoModulesCore
import Foundation
import AVFoundation
import WatchConnectivity

private enum WatchPacketKind: UInt8 {
  case output = 1
  case input = 2
  case flush = 3
}

private struct WatchAudioPacket {
  let kind: WatchPacketKind
  let sessionId: String
  let sampleRate: UInt32
  let sequence: UInt32
  let pcm: Data

  func data() -> Data? {
    guard let id = sessionId.data(using: .utf8), id.count <= UInt8.max, pcm.count > 0 || kind == .flush else {
      return nil
    }
    var data = Data([1, kind.rawValue, UInt8(id.count)])
    data.appendUInt32(sampleRate)
    data.appendUInt32(sequence)
    data.append(id)
    data.append(pcm)
    return data
  }

  static func decode(_ data: Data) -> WatchAudioPacket? {
    guard data.count >= 11, data[0] == 1, let kind = WatchPacketKind(rawValue: data[1]) else { return nil }
    let idLength = Int(data[2])
    guard data.count >= 11 + idLength else { return nil }
    let rate = data.uint32(at: 3)
    let sequence = data.uint32(at: 7)
    guard let id = String(data: data.subdata(in: 11..<(11 + idLength)), encoding: .utf8), !id.isEmpty else { return nil }
    let pcm = data.subdata(in: (11 + idLength)..<data.count)
    return WatchAudioPacket(kind: kind, sessionId: id, sampleRate: rate, sequence: sequence, pcm: pcm)
  }
}

private extension Data {
  mutating func appendUInt32(_ value: UInt32) {
    var little = value.littleEndian
    append(Data(bytes: &little, count: 4))
  }

  func uint32(at offset: Int) -> UInt32 {
    guard offset >= 0, offset + 4 <= count else { return 0 }
    return withUnsafeBytes { bytes in
      bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
    }
  }

  var pcmLevel: Double {
    guard count >= 2 else { return 0 }
    var sum = 0.0
    var samples = 0
    for offset in stride(from: 0, to: count - 1, by: 2) {
      let value = Int16(bitPattern: uint16(at: offset))
      let normalized = Double(value) / 32768.0
      sum += normalized * normalized
      samples += 1
    }
    guard samples > 0 else { return 0 }
    return Swift.min(1, (sum / Double(samples)).squareRoot() * 4)
  }

  private func uint16(at offset: Int) -> UInt16 {
    UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
  }
}

public final class BotkinsWatchModule: Module {
  private let bridge = PhoneWatchSession()

  public func definition() -> ModuleDefinition {
    Name("BotkinsWatch")
    Events("command", "frame", "reachability", "output", "interrupted", "rtcMessage", "rtcState", "rtcLevel", "rtcInterrupted")

    OnDestroy {
      Task { @MainActor [bridge = self.bridge] in bridge.shutdown() }
    }

    AsyncFunction("start") { [self] () async in
      await self.bridge.start(notify: { [weak self] event, data in self?.sendEvent(event, data) })
    }
    AsyncFunction("update") { (snapshot: String) async in
      await self.bridge.update(snapshot)
    }
    AsyncFunction("clear") { () async in
      await self.bridge.clear()
    }
    AsyncFunction("voiceStarted") { (sessionId: String, inputRate: Int, outputRate: Int) async throws in
      try await self.bridge.voiceStarted(sessionId, inputRate, outputRate)
    }
    AsyncFunction("voiceEnded") { (sessionId: String, reason: String?) async in
      await self.bridge.voiceEnded(sessionId, reason)
    }
    Function("play") { (sessionId: String, base64: String) in
      DispatchQueue.main.async { self.bridge.play(sessionId, base64) }
    }
    Function("flush") { (sessionId: String) in
      DispatchQueue.main.async { self.bridge.flush(sessionId) }
    }
    AsyncFunction("rtcStart") { (sessionId: String) async throws -> String in
      try await self.bridge.rtcStart(sessionId)
    }
    AsyncFunction("rtcAnswer") { (sessionId: String, sdp: String) async throws in
      try await self.bridge.rtcAnswer(sessionId, sdp)
    }
    Function("rtcSend") { (sessionId: String, message: String) in
      DispatchQueue.main.async { self.bridge.rtcSend(sessionId, message) }
    }
    Function("rtcInput") { (sessionId: String, enabled: Bool) in
      DispatchQueue.main.async { self.bridge.rtcInput(sessionId, enabled) }
    }
    Function("rtcFlush") { (sessionId: String) in
      DispatchQueue.main.async { self.bridge.rtcFlush(sessionId) }
    }
    AsyncFunction("rtcEnd") { (sessionId: String) async in
      await self.bridge.rtcEnd(sessionId)
    }
  }
}

@MainActor
private final class PhoneWatchSession: NSObject, WCSessionDelegate {
  nonisolated override init() { super.init() }

  private var emit: ((String, [String: Any]) -> Void)?
  func shutdown() {
    disconnect?.cancel()
    rtc?.close()
    rtc = nil
    if voiceSession != nil { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
    voiceSession = nil
    stopKeepAliveAudio()
    emit = nil
  }
  private var voiceSession: String?
  private var inputSequence: UInt32 = 0
  private var outputSequence: UInt32 = 0
  private var outputRate: UInt32 = 24_000
  private var lastSnapshot: String?
  private var disconnect: Task<Void, Never>?
  private var rtc: WatchRTCPeer?
  private var lastRtcLevel = Date.distantPast
  private var keepAliveEngine: AVAudioEngine?
  private var keepAlivePlayer: AVAudioPlayerNode?
  private var session: WCSession? {
    WCSession.isSupported() ? WCSession.default : nil
  }

  func start(notify: @escaping (String, [String: Any]) -> Void) {
    self.emit = notify
    guard let session = self.session else { return }
    session.delegate = self
    if session.activationState == .notActivated { session.activate() }
    self.tellReachability(session)
  }

  func update(_ snapshot: String) {
    guard let session = self.session else { return }
    self.lastSnapshot = snapshot
    do {
      try session.updateApplicationContext(["snapshot": snapshot])
    } catch {
      // The next sync still carries the latest revision.
    }
    if session.isReachable {
      session.sendMessage(["kind": "snapshot", "snapshot": snapshot], replyHandler: nil, errorHandler: nil)
    }
  }

  func clear() {
    let hadCall = self.voiceSession != nil
    self.voiceSession = nil
    self.lastSnapshot = nil
    self.rtc?.close()
    self.rtc = nil
    self.disconnect?.cancel()
    self.disconnect = nil
    self.stopKeepAliveAudio()
    if hadCall { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
    guard let session = self.session, session.activationState == .activated, session.isWatchAppInstalled else { return }
    try? session.updateApplicationContext(["kind": "clear"])
    if session.isReachable {
      session.sendMessage(["kind": "clear"], replyHandler: nil, errorHandler: nil)
    }
  }

  func voiceStarted(_ sessionId: String, _ inputRate: Int, _ outputRate: Int) throws {
    guard let session = self.session, session.isPaired, session.isWatchAppInstalled, session.isReachable else {
      throw Exception(name: "E_WATCH_UNREACHABLE", description: "The Watch and iPhone are not reachable.")
    }
    self.voiceSession = sessionId
    self.inputSequence = 0
    self.outputSequence = 0
    self.lastRtcLevel = Date.distantPast
    self.outputRate = UInt32(max(1, outputRate))
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.playback, mode: .spokenAudio, options: [])
      try audio.setPreferredSampleRate(Double(inputRate))
      try audio.setPreferredIOBufferDuration(0.02)
      try audio.setActive(true)
      try self.startKeepAliveAudio()
    } catch {
      self.voiceSession = nil
      self.stopKeepAliveAudio()
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      throw Exception(name: "E_WATCH_AUDIO", description: "The Watch voice session could not keep audio active.")
    }
    self.send(["kind": "voiceStarted", "sessionId": sessionId, "inputRate": inputRate, "outputRate": outputRate])
  }

  func voiceEnded(_ sessionId: String, _ reason: String?) {
    guard self.voiceSession == sessionId else { return }
    self.voiceSession = nil
    self.stopKeepAliveAudio()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    self.disconnect?.cancel()
    self.disconnect = nil
    var message: [String: Any] = ["kind": "voiceEnded", "sessionId": sessionId]
    message["reason"] = reason
    self.send(message)
  }

  func play(_ sessionId: String, _ base64: String) {
    guard self.voiceSession == sessionId,
          let pcm = Data(base64Encoded: base64), !pcm.isEmpty,
          let session = self.session, session.isReachable else { return }
    self.outputSequence &+= 1
    let packet = WatchAudioPacket(kind: .output, sessionId: sessionId, sampleRate: self.outputRate, sequence: self.outputSequence, pcm: pcm)
    guard let data = packet.data() else { return }
    session.sendMessageData(data, replyHandler: nil) { [weak self] _ in
      Task { @MainActor in self?.emit?("interrupted", ["sessionId": sessionId, "began": true, "failed": true]) }
    }
  }

  func flush(_ sessionId: String) {
    guard self.voiceSession == sessionId, let session = self.session, session.isReachable else { return }
    self.outputSequence &+= 1
    let packet = WatchAudioPacket(kind: .flush, sessionId: sessionId, sampleRate: self.outputRate, sequence: self.outputSequence, pcm: Data())
    if let data = packet.data() { session.sendMessageData(data, replyHandler: nil, errorHandler: nil) }
  }

  func rtcStart(_ sessionId: String) async throws -> String {
    guard let session = self.session, session.isPaired, session.isWatchAppInstalled, session.isReachable else {
      throw Exception(name: "E_WATCH_UNREACHABLE", description: "The Watch and iPhone are not reachable.")
    }
    self.rtc?.close()
    self.voiceSession = sessionId
    self.outputRate = 24_000
    self.inputSequence = 0
    self.outputSequence = 0
    self.lastRtcLevel = Date.distantPast
    let peer = WatchRTCPeer(
      sessionId: sessionId,
      onMessage: { [weak self] message in
        Task { @MainActor in self?.emit?("rtcMessage", ["sessionId": sessionId, "message": message]) }
      },
      onState: { [weak self] state in
        Task { @MainActor in self?.emit?("rtcState", ["sessionId": sessionId, "state": state]) }
      },
      onPlayout: { [weak self] pcm in
        Task { @MainActor in self?.sendRtcAudio(sessionId: sessionId, pcm: pcm) }
      },
      onLevel: { [weak self] mic, output in
        Task { @MainActor in
          guard let self, Date().timeIntervalSince(self.lastRtcLevel) >= 0.1 else { return }
          self.lastRtcLevel = Date()
          self.emit?("rtcLevel", ["sessionId": sessionId, "mic": mic, "output": output])
        }
      },
      onInterrupt: { [weak self] in
        Task { @MainActor in self?.emit?("rtcInterrupted", ["sessionId": sessionId, "failed": false]) }
      }
    )
    self.rtc = peer
    self.send(["kind": "voiceStarted", "sessionId": sessionId, "inputRate": 24_000, "outputRate": 24_000])
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.playback, mode: .spokenAudio, options: [])
      try audio.setPreferredSampleRate(24_000)
      try audio.setPreferredIOBufferDuration(0.02)
      try audio.setActive(true)
      try self.startKeepAliveAudio()
      return try await peer.offer()
    } catch {
      peer.close()
      guard self.voiceSession == sessionId else { throw error }
      self.rtc = nil
      self.voiceSession = nil
      self.stopKeepAliveAudio()
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      self.send(["kind": "voiceEnded", "sessionId": sessionId, "reason": "The Watch voice connection could not start."])
      throw Exception(name: "E_WATCH_RTC", description: "The Watch voice connection could not be created.")
    }
  }

  func rtcAnswer(_ sessionId: String, _ sdp: String) async throws {
    guard self.rtc?.sessionId == sessionId else {
      throw Exception(name: "E_WATCH_RTC", description: "That Watch voice session ended.")
    }
    do {
      try await self.rtc?.answer(sdp)
    } catch {
      throw Exception(name: "E_WATCH_RTC", description: "The Watch voice answer could not be connected.")
    }
  }

  func rtcSend(_ sessionId: String, _ message: String) {
    guard self.rtc?.sessionId == sessionId else { return }
    _ = self.rtc?.send(message)
  }

  func rtcInput(_ sessionId: String, _ enabled: Bool) {
    guard self.rtc?.sessionId == sessionId else { return }
    self.rtc?.setInput(enabled)
  }

  func rtcFlush(_ sessionId: String) {
    guard self.rtc?.sessionId == sessionId else { return }
    self.flushAudio(sessionId: sessionId)
  }

  func rtcEnd(_ sessionId: String) {
    guard self.voiceSession == sessionId else { return }
    self.rtc?.close()
    self.rtc = nil
    self.voiceSession = nil
    self.stopKeepAliveAudio()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    self.disconnect?.cancel()
    self.disconnect = nil
    self.send(["kind": "voiceEnded", "sessionId": sessionId])
  }

  private func send(_ message: [String: Any]) {
    guard let session else { return }
    if session.isReachable {
      session.sendMessage(message, replyHandler: nil, errorHandler: nil)
    }
  }

  /// A silent running engine keeps iOS from suspending the Watch audio bridge between packets.
  private func startKeepAliveAudio() throws {
    if keepAliveEngine?.isRunning == true { return }
    stopKeepAliveAudio()
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_800) else {
      throw NSError(domain: "BotkinsWatch", code: 1)
    }
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    player.volume = 0
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    buffer.frameLength = 4_800
    engine.prepare()
    try engine.start()
    player.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
    player.play()
    keepAliveEngine = engine
    keepAlivePlayer = player
  }

  private func stopKeepAliveAudio() {
    keepAlivePlayer?.stop()
    keepAliveEngine?.stop()
    keepAlivePlayer = nil
    keepAliveEngine = nil
  }

  private func sendRtcAudio(sessionId: String, pcm: Data) {
    guard voiceSession == sessionId, let session, session.isReachable else { return }
    outputSequence &+= 1
    let packet = WatchAudioPacket(kind: .output, sessionId: sessionId, sampleRate: 24_000, sequence: outputSequence, pcm: pcm)
    if let data = packet.data() {
      session.sendMessageData(data, replyHandler: nil) { [weak self] _ in
        Task { @MainActor in self?.emit?("rtcInterrupted", ["sessionId": sessionId, "failed": true]) }
      }
    }
  }

  private func flushAudio(sessionId: String) {
    guard voiceSession == sessionId, let session, session.isReachable else { return }
    outputSequence &+= 1
    let packet = WatchAudioPacket(kind: .flush, sessionId: sessionId, sampleRate: outputRate, sequence: outputSequence, pcm: Data())
    if let data = packet.data() { session.sendMessageData(data, replyHandler: nil, errorHandler: nil) }
  }

  private func tellReachability(_ session: WCSession) {
    let reachable = session.isReachable
    emit?("reachability", [
      "reachable": reachable,
      "paired": session.isPaired,
      "installed": session.isWatchAppInstalled,
    ])
    if let snapshot = lastSnapshot {
      try? session.updateApplicationContext(["snapshot": snapshot])
    }
    disconnect?.cancel()
    disconnect = nil
    if !reachable, let id = voiceSession {
      disconnect = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled, self?.session?.isReachable == false, self?.voiceSession == id else { return }
        if self?.rtc?.sessionId == id {
          self?.emit?("rtcInterrupted", ["sessionId": id, "failed": true])
        } else {
          self?.emit?("interrupted", ["sessionId": id, "began": true, "failed": true])
        }
        self?.send(["kind": "voiceEnded", "sessionId": id, "reason": "The Watch and iPhone lost their connection."])
        self?.rtc?.close()
        self?.rtc = nil
        self?.stopKeepAliveAudio()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        self?.voiceSession = nil
      }
    }
  }

  // MARK: WCSessionDelegate

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if error == nil && activationState == .activated { Task { @MainActor in tellReachability(session) } }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    Task { @MainActor in tellReachability(session) }
  }

  nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
    Task { @MainActor in tellReachability(session) }
  }

  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

  nonisolated func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    Task { @MainActor in accept(message) }
  }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    Task { @MainActor in accept(message) }
    replyHandler(["accepted": true])
  }

  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    Task { @MainActor in accept(userInfo) }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    Task { @MainActor in accept(applicationContext) }
  }

  nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
    Task { @MainActor in receiveAudio(messageData) }
  }

  private func receiveAudio(_ messageData: Data) {
    guard let packet = WatchAudioPacket.decode(messageData),
          packet.kind == .input,
          packet.sessionId == voiceSession,
          packet.sequence > inputSequence else { return }
    inputSequence = packet.sequence
    if rtc?.sessionId == packet.sessionId {
      rtc?.input(packet.pcm)
      return
    }
    emit?("frame", [
      "sessionId": packet.sessionId,
      "sequence": Int(packet.sequence),
      "data": packet.pcm.base64EncodedString(),
      "level": packet.pcm.pcmLevel,
    ])
  }

  private func accept(_ message: [String: Any]) {
    if message["kind"] as? String == "outputLevel" {
      if let id = message["sessionId"] as? String, let level = message["level"] as? Double, id == voiceSession {
        emit?("output", ["sessionId": id, "level": max(0, min(level, 1))])
      }
      return
    }
    if message["kind"] as? String == "audioInterrupted" {
      if let id = message["sessionId"] as? String, id == voiceSession {
        if rtc?.sessionId == id {
          emit?("rtcInterrupted", ["sessionId": id, "failed": true])
        } else {
          emit?("interrupted", ["sessionId": id, "began": true, "failed": message["failed"] as? Bool ?? false])
        }
      }
      return
    }
    guard let command = message["command"] as? String else { return }
    var value: [String: Any] = ["command": command]
    if let flag = message["value"] as? Bool { value["value"] = flag }
    if let chat = message["chatId"] as? String, !chat.isEmpty, chat.count <= 200 { value["chatId"] = chat }
    var event: [String: Any] = ["command": value]
    if let revision = message["revision"] as? NSNumber { event["revision"] = revision.int64Value }
    if let sessionId = message["sessionId"] as? String, sessionId.count <= 200 { event["sessionId"] = sessionId }
    emit?("command", event)
  }
}
