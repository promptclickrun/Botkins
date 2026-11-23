// A WebRTC audio device whose input/output bytes belong to the companion Watch. WebRTC sees one
// normal 24 kHz mono PCM16 device; no iPhone microphone or speaker track is involved.
import AVFAudio
import Foundation
import WebRTC

final class WatchRTCAudioDevice: NSObject, RTCAudioDevice {
  private static let rate: Double = 24_000
  private let queue = DispatchQueue(label: "app.botkins.watch.webrtc-audio")
  private let onPlayout: (Data) -> Void
  private let onLevel: (Double, Double) -> Void
  private let onInterrupt: () -> Void
  private var delegate: RTCAudioDeviceDelegate?
  private var timer: DispatchSourceTimer?
  private var playing = false
  private var recording = false
  private var initialized = false
  private var inputOpen = true
  private var inputBuffer = Data()
  private var inputLevel = 0.0
  private var outputLevel = 0.0
  private var loudFrames = 0

  init(
    onPlayout: @escaping (Data) -> Void,
    onLevel: @escaping (Double, Double) -> Void,
    onInterrupt: @escaping () -> Void
  ) {
    self.onPlayout = onPlayout
    self.onLevel = onLevel
    self.onInterrupt = onInterrupt
    super.init()
  }

  func setInput(_ enabled: Bool) {
    queue.async {
      self.inputOpen = enabled
      if !enabled { self.inputBuffer.removeAll() }
    }
  }

  func recorded(_ pcm: Data) {
    queue.async {
      guard self.initialized, self.recording, !pcm.isEmpty else { return }
      if self.inputOpen {
        self.inputBuffer.append(pcm)
        let maximum = Int(Self.rate * 0.7) * 2
        if self.inputBuffer.count > maximum {
          self.inputBuffer.removeFirst(self.inputBuffer.count - maximum)
        }
      }
      let mic = Self.level(pcm)
      self.inputLevel = mic
      self.onLevel(mic, self.outputLevel)
      if self.outputLevel > 0.02 && mic >= max(0.2, self.outputLevel * 3) {
        self.loudFrames += 1
        if self.loudFrames >= 3 {
          self.loudFrames = 0
          self.onInterrupt()
        }
      } else {
        self.loudFrames = 0
      }
    }
  }

  private func beginTimer() {
    guard timer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + outputIOBufferDuration, repeating: outputIOBufferDuration)
    timer.setEventHandler { [weak self] in
      self?.pullRecording()
      self?.pullPlayout()
    }
    timer.resume()
    self.timer = timer
  }

  private func pullRecording() {
    guard recording, initialized, let delegate else { return }
    let frames = Int(Self.rate * outputIOBufferDuration)
    let bytes = frames * 2
    let memory = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: MemoryLayout<Int16>.alignment)
    defer { memory.deallocate() }
    memset(memory, 0, bytes)
    if inputOpen, inputBuffer.count >= bytes {
      let chunk = inputBuffer.prefix(bytes)
      chunk.copyBytes(to: memory.assumingMemoryBound(to: UInt8.self), count: bytes)
      inputBuffer.removeFirst(bytes)
    }
    let buffer = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: memory)
    var list = AudioBufferList(mNumberBuffers: 1, mBuffers: buffer)
    var timestamp = AudioTimeStamp()
    timestamp.mHostTime = mach_absolute_time()
    timestamp.mFlags = .hostTimeValid
    var flags: AudioUnitRenderActionFlags = []
    _ = delegate.deliverRecordedData(&flags, &timestamp, 1, UInt32(frames), &list, nil, nil)
  }

  private func stopTimerWhenIdle() {
    guard !recording && !playing else { return }
    timer?.cancel()
    timer = nil
  }

  private func pullPlayout() {
    guard playing, initialized, let delegate else { return }
    let frames = Int(Self.rate * outputIOBufferDuration)
    let bytes = frames * 2
    let memory = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: MemoryLayout<Int16>.alignment)
    defer { memory.deallocate() }
    memset(memory, 0, bytes)
    let buffer = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: memory)
    var list = AudioBufferList(mNumberBuffers: 1, mBuffers: buffer)
    var timestamp = AudioTimeStamp()
    timestamp.mHostTime = mach_absolute_time()
    timestamp.mFlags = .hostTimeValid
    var flags: AudioUnitRenderActionFlags = []
    guard delegate.getPlayoutData(&flags, &timestamp, 0, UInt32(frames), &list) == noErr else { return }
    let data = Data(bytes: memory, count: bytes)
    let output = Self.level(data)
    outputLevel = output
    onLevel(inputLevel, output)
    onPlayout(data)
  }

  private static func level(_ data: Data) -> Double {
    guard data.count >= 2 else { return 0 }
    var sum = 0.0
    var count = 0
    for offset in stride(from: 0, to: data.count - 1, by: 2) {
      let sample = Int16(bitPattern: UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8))
      let normalized = Double(sample) / 32768.0
      sum += normalized * normalized
      count += 1
    }
    return count == 0 ? 0 : min(1, (sum / Double(count)).squareRoot() * 4)
  }

  // MARK: - RTCAudioDevice

  var deviceInputSampleRate: Double { Self.rate }
  var inputIOBufferDuration: TimeInterval { 0.02 }
  var deviceOutputSampleRate: Double { Self.rate }
  var outputIOBufferDuration: TimeInterval { 0.02 }
  var inputNumberOfChannels: Int { 1 }
  var outputNumberOfChannels: Int { 1 }
  var inputLatency: TimeInterval { 0.01 }
  var outputLatency: TimeInterval { 0.01 }
  var isInitialized: Bool { initialized }

  func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
    queue.sync {
      guard !initialized else { return false }
      self.delegate = delegate
      initialized = true
      return true
    }
  }

  func terminateDevice() -> Bool {
    queue.sync {
      playing = false
      recording = false
      timer?.cancel()
      timer = nil
      inputBuffer.removeAll()
      delegate = nil
      initialized = false
      return true
    }
  }

  var isPlayoutInitialized: Bool { initialized }
  func initializePlayout() -> Bool { initialized }
  var isPlaying: Bool { queue.sync { playing } }

  func startPlayout() -> Bool {
    queue.sync {
      playing = true
      beginTimer()
      return true
    }
  }

  func stopPlayout() -> Bool {
    queue.sync {
      playing = false
      stopTimerWhenIdle()
      return true
    }
  }

  var isRecordingInitialized: Bool { initialized }
  func initializeRecording() -> Bool { initialized }
  var isRecording: Bool { queue.sync { recording } }

  func startRecording() -> Bool {
    queue.sync {
      recording = true
      beginTimer()
      return true
    }
  }

  func stopRecording() -> Bool {
    queue.sync {
      recording = false
      inputBuffer.removeAll()
      stopTimerWhenIdle()
      return true
    }
  }
}
