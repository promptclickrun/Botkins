package app.botkins.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

@Suppress("DEPRECATION")
class BotkinsCallRoutesModule : Module() {
  private val audio by lazy {
    requireNotNull(appContext.reactContext).getSystemService(Context.AUDIO_SERVICE) as AudioManager
  }
  private var previousMode: Int? = null
  private var previousSpeaker = false
  private var startedSco = false
  private var observing = false
  private val callback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(devices: Array<AudioDeviceInfo>) = changed()
    override fun onAudioDevicesRemoved(devices: Array<AudioDeviceInfo>) = changed()
  }

  private fun changed() {
    sendEvent("devicesChanged")
  }

  private fun external(device: AudioDeviceInfo): Boolean = when (device.type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_HEARING_AID, AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_BLE_SPEAKER -> true
    else -> false
  }

  private fun accessory(): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT >= 31) {
      return audio.communicationDevice?.takeIf(::external)
        ?: audio.availableCommunicationDevices.firstOrNull(::external)
    }
    return audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull(::external)
  }

  private fun route(speaker: Boolean) {
    if (previousMode == null) {
      previousMode = audio.mode
      previousSpeaker = audio.isSpeakerphoneOn
    }
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= 31) {
      val type = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
      val device = (if (speaker) null else accessory())
        ?: audio.availableCommunicationDevices.firstOrNull { it.type == type }
      if (device == null || !audio.setCommunicationDevice(device)) audio.clearCommunicationDevice()
    } else {
      val sco = !speaker && accessory()?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
      if (sco && !startedSco) audio.startBluetoothSco()
      if (!sco && startedSco) audio.stopBluetoothSco()
      startedSco = sco
      audio.isSpeakerphoneOn = speaker
    }
  }

  private fun endCall() {
    val mode = previousMode ?: return
    if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice()
    else {
      if (startedSco) audio.stopBluetoothSco()
      startedSco = false
      audio.isSpeakerphoneOn = previousSpeaker
    }
    audio.mode = mode
    previousMode = null
  }

  private fun stopObserving() {
    if (observing) audio.unregisterAudioDeviceCallback(callback)
    observing = false
  }

  override fun definition() = ModuleDefinition {
    Name("BotkinsCallRoutes")
    Events("devicesChanged")
    Function("accessory") { accessory()?.id?.toString() }
    Function("setSpeaker") { speaker: Boolean -> route(speaker) }
    Function("endCall") { endCall() }
    OnStartObserving("devicesChanged") {
      audio.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
      observing = true
    }
    OnStopObserving("devicesChanged") { stopObserving() }
    OnDestroy {
      stopObserving()
      endCall()
    }
  }
}
