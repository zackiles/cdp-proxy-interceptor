export class MockWebSocket extends EventTarget implements WebSocket {
  // Keep both for backward compatibility and internal use
  static readonly STATES = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as const

  // Static constants for WebSocket interface compatibility
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  // Instance constants
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  private _readyState = 0
  private _protocol = ''
  private _extensions = ''
  private _bufferedAmount = 0
  private _binaryType: BinaryType = 'blob'
  private _sentMessages: string[] = []
  private _lastSentMessage: string | null = null

  onopen: ((this: WebSocket, ev: Event) => any) | null = null
  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
  onerror: ((this: WebSocket, ev: Event | ErrorEvent) => any) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null

  constructor(private readonly _url: string) {
    super()
    setTimeout(() => this._readyState === this.CONNECTING && this.simulateOpen(), 0)
  }

  get url() { return this._url }
  get readyState() { return this._readyState }
  get bufferedAmount() { return this._bufferedAmount }
  get extensions() { return this._extensions }
  get protocol() { return this._protocol }
  get binaryType() { return this._binaryType }
  set binaryType(value: BinaryType) { this._binaryType = value }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._readyState !== this.OPEN) {
      throw new Error('WebSocket is not open')
    }
    const message = typeof data === 'string' ? data : JSON.stringify(data)
    this._sentMessages.push(message)
    this._lastSentMessage = message
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === this.CLOSED) return
    this._readyState = this.CLOSING
    setTimeout(() => {
      this._readyState = this.CLOSED
      const event = new CloseEvent('close', { code, reason, wasClean: true })
      this.dispatchEvent(event)
      this.onclose?.call(this as unknown as WebSocket, event)
    }, 0)
  }

  // Helper methods for testing
  getSentMessages = () => [...this._sentMessages]
  getLastSentMessage = () => this._lastSentMessage

  simulateOpen(): void {
    if (this._readyState === this.CONNECTING) {
      this._readyState = this.OPEN
      const event = new Event('open')
      this.dispatchEvent(event)
      this.onopen?.call(this as unknown as WebSocket, event)
    }
  }

  simulateError(message: string): void {
    const errorEvent = new ErrorEvent('error', { message })
    this.dispatchEvent(errorEvent)
    this.onerror?.call(this as unknown as WebSocket, errorEvent)
  }

  simulateMessage(data: string): void {
    const messageEvent = new MessageEvent('message', { data })
    this.dispatchEvent(messageEvent)
    this.onmessage?.call(this as unknown as WebSocket, messageEvent)
  }

  setReadyState(state: number): void {
    this._readyState = state
  }
}
