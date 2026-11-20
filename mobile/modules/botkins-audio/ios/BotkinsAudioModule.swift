// Two-way audio for live voice.
//
// One audio engine with the phone's voice processing on: the microphone is cleaned of the sound the
// speaker is making (so a bot does not hear itself and interrupt itself), and what arrives from the
// provider is queued on a player node. JavaScript gets the microphone as small pieces of 16-bit mono
// PCM at the rate it asked for, base64, and hands back PCM at its output rate to play.
//
//   start({ inputRate, outputRate, speaker })   asks for the microphone, then runs until stop()
//   play(base64)                                queues sound
//   flush()                                     drops what is queued and playing (the person spoke)
//   setMuted(bool), setSpeaker(bool), stop()
//   events: frame { data, level }, output { level }, interrupted { began }
import AVFoundation
import ExpoModulesCore

struct DuplexOptions: Record {
  @Field var inputRate: Double = 16000
  @Field var outputRate: Double = 24000
  @Field var speaker: Bool = true
}

public final class BotkinsAudioModule: Module {
  private let queue = DispatchQueue(label: "app.botkins.audio")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var wireFormat: AVAudioFormat?
  private var playFormat: AVAudioFormat?
  private var options = DuplexOptions()
  private var muted = false
  private var running = false
  /// Microphone sound waiting to fill a piece of about 40 ms.
  private var held = Data()
  private var lastOutput = Date.distantPast
  /// When the engine was last started again after the hardware changed, to notice a loop.
  private var restarts: [Date] = []
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("BotkinsAudio")

    Events("frame", "output", "interrupted")

    AsyncFunction("start") { (options: DuplexOptions, promise: Promise) in
      self.askForMicrophone { allowed in
        guard allowed else {
          promise.reject("E_MICROPHONE", "Microphone access is off. Turn it on for Botkins in Settings.")
          return
        }
        self.queue.async {
          do {
            self.options = options
            try self.begin()
            promise.resolve(nil)
          } catch {
            self.end()
            promise.reject("E_AUDIO", "The microphone could not be started.")
          }
        }
      }
    }

    Function("play") { (base64: String) in
      guard let data = Data(base64Encoded: base64), !data.isEmpty else { return }
      self.queue.async { self.enqueue(data) }
    }

    Function("flush") {
      self.queue.async {
        guard let player = self.player, self.running else { return }
        // Stopping the node drops everything scheduled on it.
        player.stop()
        player.play()
      }
    }

    Function("setMuted") { (muted: Bool) in
      self.queue.async {
        self.muted = muted
        self.held.removeAll(keepingCapacity: true)
      }
    }

    Function("setSpeaker") { (on: Bool) in
      self.queue.async {
        self.options.speaker = on
        guard self.running else { return }
        let session = AVAudioSession.sharedInstance()
        var sessionOptions: AVAudioSession.CategoryOptions = [.allowBluetooth]
        if on { sessionOptions.insert(.defaultToSpeaker) }
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: sessionOptions)
        try? session.overrideOutputAudioPort(on ? .speaker : .none)
        // A route change can stop the engine; the configuration observer starts it again, and so does this.
        if let engine = self.engine, !engine.isRunning { try? engine.start() }
        self.player?.play()
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.queue.async {
        self.end()
        promise.resolve(nil)
      }
    }

    OnDestroy {
      self.queue.async { self.end() }
    }
  }

  private func askForMicrophone(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { done($0) }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { done($0) }
    }
  }

  /// Sets the session for a call and starts the engine. Called on `queue`.
  private func begin() throws {
    end()
    let session = AVAudioSession.sharedInstance()
    var sessionOptions: AVAudioSession.CategoryOptions = [.allowBluetooth]
    if options.speaker { sessionOptions.insert(.defaultToSpeaker) }
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: sessionOptions)
    try? session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)

    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    // Voice processing is the echo canceller. It has to be on before the engine starts.
    try engine.inputNode.setVoiceProcessingEnabled(true)
    engine.attach(player)
    self.engine = engine
    self.player = player
    self.held.removeAll(keepingCapacity: true)
    self.restarts.removeAll()
    try wire()
    running = true
    watch()
  }

  /// Connects the player and the two taps for the formats the hardware has now, and starts the engine.
  /// Called at the start, and again when the hardware changed under a running call. The session is
  /// left alone here: setting it again is what makes the phone's volume jump.
  private func wire() throws {
    guard let engine, let player else { throw NSError(domain: "BotkinsAudio", code: 3) }
    guard
      let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: options.outputRate, channels: 1, interleaved: false),
      let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: options.inputRate, channels: 1, interleaved: true)
    else { throw NSError(domain: "BotkinsAudio", code: 1) }
    engine.inputNode.removeTap(onBus: 0)
    engine.mainMixerNode.removeTap(onBus: 0)
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)

    let micFormat = engine.inputNode.outputFormat(forBus: 0)
    guard micFormat.sampleRate > 0, micFormat.channelCount > 0, let converter = AVAudioConverter(from: micFormat, to: wireFormat) else { throw NSError(domain: "BotkinsAudio", code: 2) }
    self.wireFormat = wireFormat
    self.playFormat = playFormat

    // The tap's buffer is only good inside the callback, so it is converted there and the bytes move on.
    engine.inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(micFormat.sampleRate * 0.04), format: micFormat) { [weak self] buffer, _ in
      guard let data = BotkinsAudioModule.pcm(buffer, with: converter, from: micFormat, to: wireFormat) else { return }
      self?.queue.async { self?.heard(data) }
    }
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, _ in
      self?.played(buffer)
    }
    engine.prepare()
    try engine.start()
    player.play()
  }

  /// Stops everything and gives the sound back to other apps. Safe to call twice. Called on `queue`.
  private func end() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    guard let engine else { return }
    running = false
    engine.inputNode.removeTap(onBus: 0)
    engine.mainMixerNode.removeTap(onBus: 0)
    player?.stop()
    engine.stop()
    self.engine = nil
    self.player = nil
    held.removeAll()
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  /// The call can't go on: tells JavaScript once and stops.
  private func fail() {
    end()
    sendEvent("interrupted", ["began": true, "failed": true])
  }

  /// A phone call, Siri or another app took the sound, or the route changed (headphones in or out).
  private func watch() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      self.queue.async {
        guard self.running else { return }
        if kind == .began {
          self.sendEvent("interrupted", ["began": true])
        } else {
          try? AVAudioSession.sharedInstance().setActive(true)
          if let engine = self.engine, !engine.isRunning { try? engine.start() }
          self.player?.play()
          self.sendEvent("interrupted", ["began": false])
        }
      }
    })
    // When the hardware changes (and once, right after voice processing comes on) the engine may stop
    // itself. Then it is wired again for the new formats and started, the same engine and the same
    // session. A notice for an engine that is still running needs nothing. If it keeps stopping,
    // the call ends with a word to JavaScript instead of starting over forever.
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
      self?.queue.async {
        guard let self, self.running, let engine = self.engine, (note.object as AnyObject?) === engine, !engine.isRunning else { return }
        let now = Date()
        self.restarts = self.restarts.filter { now.timeIntervalSince($0) < 5 }
        guard self.restarts.count < 3 else { return self.fail() }
        self.restarts.append(now)
        do { try self.wire() } catch { self.fail() }
      }
    })
  }

  /// A piece of microphone sound as 16-bit mono PCM at the wire rate.
  private static func pcm(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, from micFormat: AVAudioFormat, to wireFormat: AVAudioFormat) -> Data? {
    guard buffer.frameLength > 0 else { return nil }
    let ratio = wireFormat.sampleRate / micFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return nil }
    var given = false
    var failure: NSError?
    converter.convert(to: out, error: &failure) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    guard failure == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return nil }
    return Data(buffer: UnsafeBufferPointer(start: samples, count: Int(out.frameLength)))
  }

  /// Microphone sound, already in the wire format: sent on in pieces of about 40 ms. Called on `queue`.
  private func heard(_ data: Data) {
    guard running, !muted, let wireFormat else { return }
    held.append(data)
    let piece = Int(wireFormat.sampleRate * 0.04) * 2
    while held.count >= piece {
      let chunk = Data(held.prefix(piece))
      held.removeFirst(piece)
      var sum = 0.0
      chunk.withUnsafeBytes { raw in
        for sample in raw.bindMemory(to: Int16.self) {
          let value = Double(sample) / 32768.0
          sum += value * value
        }
      }
      let level = min(1.0, (sum / Double(piece / 2)).squareRoot() * 4)
      sendEvent("frame", ["data": chunk.base64EncodedString(), "level": level])
    }
  }

  /// Sound to play: 16-bit mono PCM at the output rate.
  private func enqueue(_ data: Data) {
    guard running, let player, let playFormat else { return }
    let count = data.count / 2
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(count)), let channel = buffer.floatChannelData?[0] else { return }
    data.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for index in 0..<count { channel[index] = Float(Int16(littleEndian: samples[index])) / 32768.0 }
    }
    buffer.frameLength = AVAudioFrameCount(count)
    player.scheduleBuffer(buffer, completionHandler: nil)
    if !player.isPlaying { player.play() }
  }

  /// How loud what is playing is, a few times a second, for the avatar.
  private func played(_ buffer: AVAudioPCMBuffer) {
    let now = Date()
    guard now.timeIntervalSince(lastOutput) > 0.1, let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    lastOutput = now
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
    let level = min(1.0, Double((sum / Float(buffer.frameLength)).squareRoot()) * 4)
    sendEvent("output", ["level": level])
  }
}
