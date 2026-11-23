// Watch-side microphone and playback. PCM stays in memory and is sent to the iPhone in short
// WatchConnectivity packets.
import AVFoundation
import Foundation

final class WatchVoiceEngine {
  private let queue = DispatchQueue(label: "app.botkins.watch.voice")
  private let sendFrame: (Data, UInt32) -> Void
  private let reportLevel: (Double) -> Void
  private let interrupted: (Bool) -> Void
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private var outputFormat: AVAudioFormat?
  private var pending = Data()
  private var queuedFrames = 0
  private var observer: NSObjectProtocol?
  private var sessionId = ""
  private(set) var running = false

  init(
    sendFrame: @escaping (Data, UInt32) -> Void,
    reportLevel: @escaping (Double) -> Void,
    interrupted: @escaping (Bool) -> Void
  ) {
    self.sendFrame = sendFrame
    self.reportLevel = reportLevel
    self.interrupted = interrupted
  }

  func start(sessionId: String, inputRate: Int, outputRate: Int) throws {
    try queue.sync {
      stopLocked()
      self.sessionId = sessionId
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
      try audio.setActive(true)

      let engine = AVAudioEngine()
      let player = AVAudioPlayerNode()
      try engine.inputNode.setVoiceProcessingEnabled(true)
      engine.attach(player)
      guard
        let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(inputRate), channels: 1, interleaved: true),
        let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(outputRate), channels: 1, interleaved: false)
      else { throw NSError(domain: "BotkinsWatchVoice", code: 1) }
      let source = engine.inputNode.outputFormat(forBus: 0)
      guard let converter = AVAudioConverter(from: source, to: wire) else {
        throw NSError(domain: "BotkinsWatchVoice", code: 2)
      }
      self.engine = engine
      self.player = player
      self.converter = converter
      self.inputFormat = wire
      self.outputFormat = output
      self.pending.removeAll()
      engine.connect(player, to: engine.mainMixerNode, format: output)
      engine.inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(source.sampleRate * 0.04), format: source) { [weak self] buffer, _ in
        self?.heard(buffer, source: source, wire: wire, converter: converter)
      }
      engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
        self?.played(buffer)
      }
      observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: nil,
        queue: nil
      ) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let value = raw.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
        self?.interrupted(value == .began)
      }
      engine.prepare()
      try engine.start()
      player.play()
      running = true
    }
  }

  func play(_ data: Data) {
    queue.async { [self] in
      guard self.running,
            let player = self.player,
            let format = self.outputFormat,
            !data.isEmpty else { return }
      let count = data.count / 2
      guard count > 0,
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
            let channel = buffer.floatChannelData?[0] else { return }
      let maximum = Int(format.sampleRate * 0.7)
      guard self.queuedFrames + count <= maximum else { return }
      data.withUnsafeBytes { raw in
        let values = raw.bindMemory(to: Int16.self)
        for index in 0..<count { channel[index] = Float(Int16(littleEndian: values[index])) / 32768.0 }
      }
      buffer.frameLength = AVAudioFrameCount(count)
      self.queuedFrames += count
      player.scheduleBuffer(buffer) { [weak self] in
        guard let self else { return }
        self.queue.async { self.queuedFrames = max(0, self.queuedFrames - count) }
      }
      if !player.isPlaying { player.play() }
    }
  }

  func flush() {
    queue.async {
      self.player?.stop()
      self.player?.play()
      self.queuedFrames = 0
    }
  }

  func stop() {
    queue.sync { stopLocked() }
  }

  private func stopLocked() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    running = false
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.mainMixerNode.removeTap(onBus: 0)
    player?.stop()
    engine.stop()
    self.engine = nil
    self.player = nil
    self.converter = nil
    self.outputFormat = nil
    self.inputFormat = nil
    pending.removeAll()
    queuedFrames = 0
  }

  private func heard(_ buffer: AVAudioPCMBuffer, source: AVAudioFormat, wire: AVAudioFormat, converter: AVAudioConverter) {
    guard running, buffer.frameLength > 0 else { return }
    let ratio = wire.sampleRate / source.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return }
    var given = false
    var failure: NSError?
    converter.convert(to: output, error: &failure) { _, state in
      if given {
        state.pointee = .noDataNow
        return nil
      }
      given = true
      state.pointee = .haveData
      return buffer
    }
    guard failure == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return }
    let bytes = Int(output.frameLength) * 2
    let data = Data(bytes: samples, count: bytes)
    queue.async {
      self.pending.append(data)
      let piece = Int(wire.sampleRate * 0.04) * 2
      while self.pending.count >= piece {
        let chunk = Data(self.pending.prefix(piece))
        self.pending.removeFirst(piece)
        self.sendFrame(chunk, UInt32(wire.sampleRate))
      }
    }
  }

  private func played(_ buffer: AVAudioPCMBuffer) {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
    reportLevel(min(1, Double((sum / Float(buffer.frameLength)).squareRoot()) * 4))
  }

}
