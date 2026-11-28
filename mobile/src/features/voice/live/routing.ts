// A manual speaker choice lasts until the audio accessory changes or the call ends.
export class CallOutput {
  private accessory: string | null | undefined;
  speaker = false;

  devicesChanged(accessory: string | null) {
    if (accessory === this.accessory) return false;
    this.accessory = accessory;
    this.speaker = accessory === null;
    return true;
  }

  toggle() {
    this.speaker = !this.speaker;
  }

  setSpeaker(on: boolean) {
    this.speaker = on;
  }
}
