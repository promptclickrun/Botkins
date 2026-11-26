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
  private var interruptibleAttempt: UUID?
  private var inputSequence: UInt32 = 0
  private var outputSequence: UInt32 = 0
  private var activeSessionId: String?
  private var activeRates: (input: Int, output: Int)?
  private var lastLevelAt = Date.distantPast
  private var disconnect: Task<Void, Never>?
  private var mediaServicesLost = false
  private var mediaServicesResetCount: UInt64 = 0
  private var mediaResetWait: (id: UUID, task: Task<Void, Never>)?
  private nonisolated(unsafe) var mediaObservers: [NSObjectProtocol] = []

  var voice: WatchVoice { localVoice ?? snapshot.voice }

  override init() {
    super.init()
    let center = NotificationCenter.default
    mediaObservers = [
      center.addObserver(forName: AVAudioSession.mediaServicesWereLostNotification, object: nil, queue: nil) { [weak self] _ in
        Task { @MainActor in self?.handleMediaServicesLost() }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        Task { @MainActor in self?.handleMediaServicesReset() }
      },
    ]
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    } else {
      issue = "Watch communication is unavailable."
    }
  }

  deinit {
    for observer in mediaObservers {
      NotificationCenter.default.removeObserver(observer)
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
    Task { [weak self] in
      guard await AVAudioApplication.requestRecordPermission() else {
        self?.issue = "Allow microphone access to talk on your Watch."
        return
      }
      guard let self else { return }
      self.localVoice = WatchVoice(
        status: "connecting",
        sessionId: nil,
        chatId: self.snapshot.chat?.id,
        muted: false,
        push: self.snapshot.voice.push,
        problem: nil,
        level: 0
      )
      self.send(["command": "startVoice"], onFailure: { [weak self] in
        if self?.activeSessionId == nil, self?.localVoice?.status == "connecting" {
          self?.localVoice = nil
        }
      })
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

  private func send(_ message: [String: Any], onFailure: (() -> Void)? = nil) {
    guard reachable else {
      issue = "Phone unavailable"
      onFailure?()
      return
    }
    var envelope = message
    envelope["revision"] = snapshot.revision
    if let activeSessionId { envelope["sessionId"] = activeSessionId }
    // Passing a replyHandler makes WatchConnectivity wake a suspended iPhone companion app
    // reliably and hold the delivery until the iPhone's WCSessionDelegate processes the message.
    WCSession.default.sendMessage(envelope, replyHandler: { _ in }) { [weak self] _ in
      Task { @MainActor in
        self?.issue = "Phone unavailable"
        onFailure?()
      }
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
    if activeSessionId != nil, activeSessionId == next.voice.sessionId {
      localVoice = next.voice
    } else if next.voice.status == "idle" && localVoice?.status == "connecting" && next.voice.problem == nil {
      // Keep optimistic connecting state while the phone finishes waking and syncing before
      // startWatchVoice() publishes its own connecting/active state.
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
    if engine != nil || activeSessionId != nil { stopAudio(nil) }
    activeSessionId = id
    activeRates = (inputRate, outputRate)
    inputSequence = 0
    outputSequence = 0
    if mediaServicesLost {
      await waitForMediaServicesReset(timeout: .milliseconds(2500))
      guard activeSessionId == id, !Task.isCancelled else {
        return ["sessionId": id, "problem": "The Watch call ended."]
      }
    }
    let retryDelays: [Duration] = [.milliseconds(1200), .milliseconds(1800), .milliseconds(2500)]
    for retryIndex in 0...retryDelays.count {
      let attempt = UUID()
      let engine = makeEngine(sessionId: id, attempt: attempt)
      self.engine = engine
      var stage = "configuring audio"
      do {
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default)
        stage = "activating audio"
        try await WatchVoiceEngine.activate()
        guard self.engine === engine else { throw CancellationError() }
        stage = "starting the microphone"
        try engine.start(inputRate: inputRate, outputRate: outputRate)
        interruptibleAttempt = attempt
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
        guard self.engine === engine else { return ["sessionId": id, "problem": "The Watch call ended."] }
        let cause = error as NSError
        if cause.watchAudioServiceReset && retryIndex < retryDelays.count {
          // Dispose the orphaned graph without poking a dead audio daemon, then wait for
          // mediaServicesWereResetNotification (or bounded backoff) before retrying.
          engine.stop(deactivateSession: false)
          await waitForMediaServicesReset(timeout: retryDelays[retryIndex])
          guard self.engine === engine, !Task.isCancelled else {
            return ["sessionId": id, "problem": "The Watch call ended."]
          }
          continue
        }
        let reason = cause.watchAudioServiceReset
          ? "Watch audio service restarted while \(stage) (\(cause.code)). Try voice again."
          : "Watch microphone failed while \(stage). \(cause.localizedDescription)"
        stopAudio(reason, deactivateSession: !cause.watchAudioServiceReset)
        return ["sessionId": id, "problem": reason]
      }
    }
    return ["sessionId": id, "problem": "The Watch call ended."]
  }

  private func cancelMediaResetWait() {
    mediaResetWait?.task.cancel()
    mediaResetWait = nil
  }

  private func waitForMediaServicesReset(timeout: Duration) async {
    cancelMediaResetWait()
    let resetBefore = mediaServicesResetCount
    let waitId = UUID()
    let sleepTask = Task {
      try? await Task.sleep(for: timeout)
    }
    mediaResetWait = (waitId, sleepTask)
    await withTaskCancellationHandler {
      await sleepTask.value
    } onCancel: {
      sleepTask.cancel()
    }
    if mediaResetWait?.id == waitId { mediaResetWait = nil }
    if mediaServicesResetCount != resetBefore && !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(150))
    }
  }

  private func handleMediaServicesLost() {
    mediaServicesLost = true
    guard activeSessionId != nil, interruptibleAttempt != nil, let engine else { return }
    resuming?.cancel()
    resuming = nil
    audioPaused = true
    interruptibleAttempt = nil
    engine.stop(deactivateSession: false)
    self.engine = nil
  }

  private func handleMediaServicesReset() {
    mediaServicesLost = false
    mediaServicesResetCount &+= 1
    cancelMediaResetWait()
    guard let sessionId = activeSessionId, let rates = activeRates else { return }
    // Rebuild mid-call if media services reset during an active or lost-media call,
    // without interfering while startAudio() owns its own startup retry loop.
    if interruptibleAttempt != nil {
      resuming?.cancel()
      resuming = nil
      audioPaused = true
      interruptibleAttempt = nil
      engine?.stop(deactivateSession: false)
      engine = nil
    }
    guard audioPaused, engine == nil else { return }
    resuming?.cancel()
    resuming = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(150))
      guard let self, !Task.isCancelled, self.activeSessionId == sessionId, self.engine == nil else { return }
      let attempt = UUID()
      let engine = self.makeEngine(sessionId: sessionId, attempt: attempt)
      self.engine = engine
      do {
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default)
        try await WatchVoiceEngine.activate()
        guard !Task.isCancelled, self.engine === engine else { return }
        try engine.start(inputRate: rates.input, outputRate: rates.output)
        self.interruptibleAttempt = attempt
        self.audioPaused = false
      } catch {
        guard !Task.isCancelled, self.engine === engine else { return }
        let cause = error as NSError
        let reason = "Watch audio could not resume after media reset. " + error.localizedDescription
        self.send(["kind": "audioInterrupted", "sessionId": sessionId, "failed": true, "problem": reason])
        self.stopAudio(reason, deactivateSession: !cause.watchAudioServiceReset)
      }
    }
  }

  private func makeEngine(sessionId id: String, attempt: UUID) -> WatchVoiceEngine {
    WatchVoiceEngine(
      sendFrame: { [weak self] pcm, rate in
        Task { @MainActor in self?.sendAudio(pcm, rate: rate, sessionId: id) }
      },
      reportLevel: { [weak self] level in
        Task { @MainActor in self?.sendOutputLevel(level, sessionId: id) }
      },
      interrupted: { [weak self] began, shouldResume in
        Task { @MainActor in
          guard let self, self.interruptibleAttempt == attempt else { return }
          self.audioInterrupted(began, shouldResume: shouldResume, sessionId: id)
        }
      }
    )
  }

  private func stopAudio(_ reason: String?, deactivateSession: Bool = true) {
    interruptibleAttempt = nil
    resuming?.cancel()
    resuming = nil
    audioPaused = false
    cancelMediaResetWait()
    engine?.stop(deactivateSession: deactivateSession)
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
    activeRates = nil
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
        let cause = error as NSError
        let reason = "Watch audio could not resume. " + error.localizedDescription
        send(["kind": "audioInterrupted", "sessionId": sessionId, "failed": true, "problem": reason])
        stopAudio(reason, deactivateSession: !cause.watchAudioServiceReset)
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
