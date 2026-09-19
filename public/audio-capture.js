class HarborPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sum = 0
    this.samples = 0
    this.frames = []
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    const ratio = sampleRate / 16000
    for (let index = 0; index < channel.length; index += 1) {
      this.sum += channel[index]
      this.samples += 1
      if (this.samples >= ratio) {
        this.frames.push(Math.max(-1, Math.min(1, this.sum / this.samples)))
        this.sum = 0
        this.samples = 0
      }
    }
    if (this.frames.length >= 1600) {
      const pcm = new Int16Array(this.frames.splice(0, 1600).map(value => value < 0 ? value * 32768 : value * 32767))
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('harbor-pcm-capture', HarborPcmCapture)
