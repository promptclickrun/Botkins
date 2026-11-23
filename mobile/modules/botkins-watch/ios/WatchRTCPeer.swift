// One WebRTC peer owned by iPhone for a WebRTC-only voice provider. WatchRTCAudioDevice replaces
// both the local microphone and speaker, so no audio route on the iPhone is used.
import Foundation
import WebRTC

final class WatchRTCPeer: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
  let sessionId: String
  private let factory: RTCPeerConnectionFactory
  private let audio: WatchRTCAudioDevice
  private var peer: RTCPeerConnection?
  private var channel: RTCDataChannel?
  private let message: (String) -> Void
  private let state: (String) -> Void

  init(
    sessionId: String,
    onMessage: @escaping (String) -> Void,
    onState: @escaping (String) -> Void,
    onPlayout: @escaping (Data) -> Void,
    onLevel: @escaping (Double, Double) -> Void,
    onInterrupt: @escaping () -> Void
  ) {
    self.sessionId = sessionId
    self.message = onMessage
    self.state = onState
    let audio = WatchRTCAudioDevice(onPlayout: onPlayout, onLevel: onLevel, onInterrupt: onInterrupt)
    self.audio = audio
    RTCInitializeSSL()
    self.factory = RTCPeerConnectionFactory(
      encoderFactory: nil,
      decoderFactory: nil,
      audioDevice: audio
    )
    super.init()
  }

  func offer() async throws -> String {
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    let constraints = RTCMediaConstraints(
      mandatoryConstraints: ["OfferToReceiveAudio": "true"],
      optionalConstraints: nil
    )
    guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
      throw NSError(domain: "BotkinsWatchRTC", code: 1)
    }
    self.peer = peer
    _ = peer.add(factory.audioTrack(withTrackId: "watch-" + sessionId), streamIds: ["watch"])
    let channelConfiguration = RTCDataChannelConfiguration()
    channelConfiguration.isOrdered = true
    channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration)
    channel?.delegate = self
    let offer = try await peer.offer(for: constraints)
    try await peer.setLocalDescription(offer)
    for _ in 0..<40 {
      if peer.iceGatheringState == .complete { break }
      try? await Task.sleep(for: .milliseconds(50))
    }
    return peer.localDescription?.sdp ?? offer.sdp
  }

  func answer(_ sdp: String) async throws {
    guard let peer else { throw NSError(domain: "BotkinsWatchRTC", code: 2) }
    try await peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
  }

  func send(_ text: String) -> Bool {
    guard let channel, channel.readyState == .open else { return false }
    return channel.sendData(RTCDataBuffer(data: Data(text.utf8), isBinary: false))
  }

  func input(_ pcm: Data) {
    audio.recorded(pcm)
  }

  func setInput(_ enabled: Bool) {
    audio.setInput(enabled)
  }

  func close() {
    channel?.close()
    channel = nil
    peer?.close()
    peer = nil
    _ = audio.terminateDevice()
  }

  // MARK: - RTCDataChannelDelegate

  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    switch dataChannel.readyState {
    case .open: state("open")
    case .closing, .closed: state("closed")
    default: break
    }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    if let text = String(data: buffer.data, encoding: .utf8) { message(text) }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didChangeBufferedAmount amount: UInt64) {}

  // MARK: - RTCPeerConnectionDelegate

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    if newState == .connected || newState == .completed { state("connected") }
    else if newState == .failed || newState == .disconnected { state("failed") }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
    if newState == .failed || newState == .disconnected { state("failed") }
    else if newState == .connected { state("connected") }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
