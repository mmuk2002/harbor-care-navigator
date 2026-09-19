export class GeminiAudio {
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private capture: AudioWorkletNode | null = null
  private silent: GainNode | null = null
  private scheduled = new Set<AudioBufferSourceNode>()
  private nextTime = 0

  constructor(private stream: MediaStream, private socket: WebSocket) {}

  async start(): Promise<void> {
    const context = new AudioContext()
    this.context = context
    await context.audioWorklet.addModule('/audio-capture.js')
    await context.resume()
    this.source = context.createMediaStreamSource(this.stream)
    this.capture = new AudioWorkletNode(context, 'harbor-pcm-capture')
    this.capture.port.onmessage = event => {
      if (this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 250_000) this.socket.send(event.data as ArrayBuffer)
    }
    this.silent = context.createGain()
    this.silent.gain.value = 0
    this.source.connect(this.capture)
    this.capture.connect(this.silent)
    this.silent.connect(context.destination)
  }

  async resumeOutput(): Promise<void> { await this.context?.resume() }

  play(base64: string): void {
    const context = this.context
    if (!context || context.state === 'closed') return
    const binary = atob(base64)
    if (binary.length < 2) return
    const count = Math.floor(binary.length / 2)
    const buffer = context.createBuffer(1, count, 24000)
    const output = buffer.getChannelData(0)
    for (let index = 0; index < count; index += 1) {
      const value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8)
      output[index] = (value > 32767 ? value - 65536 : value) / 32768
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => this.scheduled.delete(source)
    this.scheduled.add(source)
    this.nextTime = Math.max(context.currentTime + 0.03, this.nextTime)
    source.start(this.nextTime)
    this.nextTime += buffer.duration
  }

  interrupt(): void {
    for (const source of this.scheduled) { try { source.stop() } catch { /* already ended */ } }
    this.scheduled.clear()
    this.nextTime = 0
  }

  mute(value: boolean): void {
    this.stream.getAudioTracks().forEach(track => { track.enabled = !value })
    if (value && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'audioStreamEnd' }))
  }

  close(): void {
    this.interrupt()
    this.capture?.disconnect()
    this.source?.disconnect()
    this.silent?.disconnect()
    void this.context?.close()
    this.context = null
  }
}
