import AVFAudio
import Foundation
import WatchConnectivity

@MainActor
final class WatchSession: NSObject, ObservableObject, WCSessionDelegate {
  @Published private(set) var snapshot = WatchSnapshot.empty
  @Published private(set) var reachable = false
  @Published private(set) var paired = false
  @Published private(set) var issue: String?
  @Published private(set) var localVoice: WatchVoice?

  @Published private(set) var audioPaused = false
  private var resuming: Task<Void, Never>?
  private var engine: WatchVoiceEngine?
  private var inputSequence: UInt32 = 0
  private var outputSequence: UInt32 = 0
  private var activeSessionId: String?
  private var lastLevelAt = Date.distantPast
  private var disconnect: Task<Void, Never>?

  var voice: WatchVoice { localVoice ?? snapshot.voice }

  override init() {
    super.init()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    } else {
      issue = "Watch communication is unavailable."
    }
  }

  func refresh() {
    send(["command": "refresh"])
  }

  func openOnPhone() {
    guard let chat = snapshot.chat else { return }
    send(["command": "openOnPhone", "chatId": chat.id])
  }

  func startVoice() {
    issue = nil
    Task {
      guard await AVAudioApplication.requestRecordPermission() else {
        issue = "Allow microphone access to talk on your Watch."
        return
      }
      send(["command": "startVoice"])
    }
  }

  func mute(_ value: Bool) {
    send(["command": "mute", "value": value])
  }

  func interrupt() {
    engine?.flush()
    send(["command": "interrupt"])
  }

  func talkDown() {
    engine?.flush()
    send(["command": "press"])
  }

  func talkUp() {
    send(["command": "release"])
  }

  func endVoice() {
    send(["command": "endVoice"])
    stopAudio(nil)
  }

  private func send(_ message: [String: Any]) {
    guard reachable else {
      issue = "Phone unavailable"
      return
    }
    var envelope = message
    envelope["revision"] = snapshot.revision
    if let activeSessionId { envelope["sessionId"] = activeSessionId }
    WCSession.default.sendMessage(envelope, replyHandler: nil) { [weak self] _ in
      Task { @MainActor in self?.issue = "Phone unavailable" }
    }
  }

  private func acceptSnapshot(_ value: Any?) {
    guard let text = value as? String, let data = text.data(using: .utf8) else { return }
    guard let next = try? JSONDecoder().decode(WatchSnapshot.self, from: data) else { return }
    if next.version != watchProtocolVersion {
      issue = "Update Botkins on your phone or Watch"
      return
    }
    guard next.revision >= snapshot.revision else { return }
    snapshot = next
    issue = nil
    if !next.voice.active, activeSessionId != nil {
      stopAudio(next.voice.problem)
    }
    if activeSessionId == next.voice.sessionId {
      localVoice = next.voice
    } else if !next.voice.active || activeSessionId != next.voice.sessionId {
      localVoice = nil
    }
  }

  private func accept(_ message: [String: Any]) {
    if let text = message["snapshot"] { acceptSnapshot(text) }
    switch message["kind"] as? String {
    case "clear":
      stopAudio(nil)
      activeSessionId = nil
      localVoice = nil
      snapshot = .empty
    case "voiceStarted":
      // Older iPhones send a one-way request.
      Task {
        let response = await startAudio(message)
        if let reason = response["problem"] as? String, let id = message["sessionId"] as? String {
          send(["kind": "audioInterrupted", "sessionId": id, "failed": true, "problem": reason])
        }
      }
    case "voiceEnded":
      guard activeSessionId == message["sessionId"] as? String else { return }
      stopAudio(message["reason"] as? String)
    default:
      break
    }
  }

  private func startAudio(_ message: [String: Any]) async -> [String: Any] {
    guard let id = message["sessionId"] as? String,
          let inputRate = message["inputRate"] as? Int, inputRate > 0,
          let outputRate = message["outputRate"] as? Int, outputRate > 0 else {
      return ["problem": "The Watch received an invalid microphone request."]
    }
    if engine != nil { stopAudio(nil) }
    activeSessionId = id
    inputSequence = 0
    outputSequence = 0
    let engine = WatchVoiceEngine(
      sendFrame: { [weak self] pcm, rate in
        Task { @MainActor in self?.sendAudio(pcm, rate: rate, sessionId: id) }
      },
      reportLevel: { [weak self] level in
        Task { @MainActor in self?.sendOutputLevel(level, sessionId: id) }
      },
      interrupted: { [weak self] began, shouldResume in
        Task { @MainActor in self?.audioInterrupted(began, shouldResume: shouldResume, sessionId: id) }
      }
    )
    self.engine = engine
    do {
      try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default)
      try await WatchVoiceEngine.activate()
      guard self.engine === engine else { throw CancellationError() }
      try engine.start(inputRate: inputRate, outputRate: outputRate)
      localVoice = WatchVoice(
        status: snapshot.voice.sessionId == id ? snapshot.voice.status : "connecting",
        sessionId: id,
        chatId: snapshot.voice.chatId,
        muted: snapshot.voice.muted,
        push: snapshot.voice.push,
        problem: nil,
        level: 0
      )
      return ["sessionId": id, "microphoneReady": true]
    } catch {
      let reason = "Watch microphone could not start. " + error.localizedDescription
      if self.engine === engine { stopAudio(reason) }
      return ["sessionId": id, "problem": reason]
    }
  }

  private func stopAudio(_ reason: String?) {
    resuming?.cancel()
    resuming = nil
    audioPaused = false
    engine?.stop()
    engine = nil
    let ended = reason ?? snapshot.voice.problem
    localVoice = WatchVoice(
      status: reason == nil && snapshot.voice.status == "idle" ? "idle" : "ended",
      sessionId: activeSessionId,
      chatId: snapshot.voice.chatId,
      muted: false,
      push: snapshot.voice.push,
      problem: ended,
      level: 0
    )
    activeSessionId = nil
    inputSequence = 0
    outputSequence = 0
  }

  private func sendAudio(_ pcm: Data, rate: UInt32, sessionId: String) {
    guard reachable, activeSessionId == sessionId else { return }
    inputSequence &+= 1
    let packet = WatchAudioPacket(kind: .input, sessionId: sessionId, sampleRate: rate, sequence: inputSequence, pcm: pcm)
    guard let data = packet.data() else { return }
    WCSession.default.sendMessageData(data, replyHandler: nil) { [weak self] error in
      Task { @MainActor in
        guard let self, self.activeSessionId == sessionId else { return }
        if (error as? WCError)?.code == .notReachable { return }
        let reason = "Watch audio could not reach the iPhone. " + error.localizedDescription
        self.send(["kind": "audioInterrupted", "sessionId": sessionId, "failed": true, "problem": reason])
        self.stopAudio(reason)
      }
    }
  }

  private func sendOutputLevel(_ level: Double, sessionId: String) {
    guard reachable, Date().timeIntervalSince(lastLevelAt) >= 0.12 else { return }
    lastLevelAt = Date()
    if let voice = localVoice ?? (snapshot.voice.sessionId == sessionId ? snapshot.voice : nil) {
      localVoice = WatchVoice(
        status: voice.status,
        sessionId: voice.sessionId,
        chatId: voice.chatId,
        muted: voice.muted,
        push: voice.push,
        problem: voice.problem,
        level: max(0, min(level, 1))
      )
    }
    WCSession.default.sendMessage(
      ["kind": "outputLevel", "sessionId": sessionId, "level": max(0, min(level, 1))],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  private func audioInterrupted(_ began: Bool, shouldResume: Bool, sessionId: String) {
    guard activeSessionId == sessionId, let engine else { return }
    resuming?.cancel()
    if began {
      audioPaused = true
      engine.pause()
      return
    }
    guard audioPaused else { return }
    resuming = Task {
      do {
        guard shouldResume else {
          throw NSError(domain: "BotkinsWatchVoice", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "watchOS did not release the audio route for this call."
          ])
        }
        try await WatchVoiceEngine.activate()
        guard !Task.isCancelled, self.engine === engine else { return }
        try engine.resume()
        audioPaused = false
      } catch {
        guard !Task.isCancelled, self.engine === engine else { return }
        let reason = "Watch audio could not resume. " + error.localizedDescription
        send(["kind": "audioInterrupted", "sessionId": sessionId, "failed": true, "problem": reason])
        stopAudio(reason)
      }
    }
  }

  private func receiveAudio(_ data: Data) {
    guard let packet = WatchAudioPacket.decode(data),
          packet.sessionId == activeSessionId,
          packet.sequence > outputSequence else { return }
    outputSequence = packet.sequence
    if packet.kind == .flush {
      engine?.flush()
    } else if packet.kind == .output {
      engine?.play(packet.pcm)
    }
  }

  // WatchConnectivity delivers delegate callbacks on its own serial queue.
  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    Task { @MainActor in
      updateReachability(session)
      accept(session.receivedApplicationContext)
      if let error { issue = error.localizedDescription }
    }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    Task { @MainActor in updateReachability(session) }
  }

  private func updateReachability(_ session: WCSession) {
    reachable = session.isReachable
    paired = session.isCompanionAppInstalled
    disconnect?.cancel()
    disconnect = nil
    if reachable {
      issue = nil
      refresh()
      return
    }
    guard activeSessionId != nil else { return }
    disconnect = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(3))
      guard !Task.isCancelled, self?.reachable == false else { return }
      self?.stopAudio("The Watch and iPhone lost their connection.")
    }
  }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    Task { @MainActor in accept(message) }
  }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    Task { @MainActor in
      if message["kind"] as? String == "voiceStarted" {
        replyHandler(await startAudio(message))
      } else {
        accept(message)
        replyHandler(["accepted": true])
      }
    }
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
}
