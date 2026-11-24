import AVFoundation
import ExpoModulesCore

public final class BotkinsCallRoutesModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("BotkinsCallRoutes")
    Events("devicesChanged")

    Function("accessory") { () -> String? in
      let session = AVAudioSession.sharedInstance()
      // Inputs remain discoverable while the user overrides output to speaker.
      if let input = session.availableInputs?.first(where: {
        [.bluetoothHFP, .headsetMic, .carAudio].contains($0.portType)
      }) {
        return input.uid
      }
      return session.currentRoute.outputs.first {
        $0.portType != .builtInReceiver && $0.portType != .builtInSpeaker
      }?.uid
    }

    // WebRTC owns the audio engine. Select the port without touching its taps or activation.
    Function("setSpeaker") { (speaker: Bool) in
      let session = AVAudioSession.sharedInstance()
      var options: AVAudioSession.CategoryOptions = [.allowBluetooth]
      if speaker { options.insert(.defaultToSpeaker) }
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
      try session.overrideOutputAudioPort(speaker ? .speaker : .none)
    }

    OnStartObserving("devicesChanged") {
      self.observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
      ) { [weak self] _ in self?.sendEvent("devicesChanged", [:]) }
    }
    OnStopObserving("devicesChanged") { self.stopObservingRoutes() }
    OnDestroy { self.stopObservingRoutes() }
  }

  private func stopObservingRoutes() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }
}
