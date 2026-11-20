// Botkins' live voice: the microphone as 16-bit PCM at the rate a provider wants
// (processorOptions.rate), in chunks of about 40 ms, posted to the page. Runs in the AudioWorklet.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rate = options?.processorOptions?.rate || 16000;
    // How far the input moves for each output sample (the context runs at the device's own rate).
    this.step = sampleRate / this.rate;
    this.pos = 0;
    this.prev = 0;
    this.size = Math.max(1, Math.round(this.rate * 0.04));
    this.out = new Int16Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || !input.length) return true;
    const n = input.length;
    let p = this.pos;
    // Linear steps between samples; index -1 is the last sample of the block before.
    while (p < n - 1) {
      const i = Math.floor(p);
      const f = p - i;
      const a = i < 0 ? this.prev : input[i];
      const b = input[i + 1];
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.size) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(this.size);
        this.filled = 0;
      }
      p += this.step;
    }
    this.pos = p - n;
    this.prev = input[n - 1];
    return true;
  }
}
registerProcessor("botkins-pcm-capture", PcmCapture);
