export class MockWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readonly CLOSED = 3 as const;

  private _readyState: number = WebSocket.CONNECTING;
  private _url: string;
  private _protocol: string = '';
  private _extensions: string = '';
  private _bufferedAmount: number = 0;
  private _binaryType: BinaryType = 'blob';
  private _sentMessages: string[] = [];
  private _lastSentMessage: string | null = null;
  private _path: string;

  onopen: ((this: WebSocket, ev: Event) => any) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;
  onerror: ((this: WebSocket, ev: Event | ErrorEvent) => any) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;

  constructor(path: string) {
    super();
    this._path = path;
    this._url = path;

    // Automatically transition to OPEN state after a small delay
    setTimeout(() => {
      if (this._readyState === this.CONNECTING) {
        this.simulateOpen();
      }
    }, 0);
  }

  get url(): string {
    return this._url;
  }

  get readyState(): number {
    return this._readyState;
  }

  get bufferedAmount(): number {
    return this._bufferedAmount;
  }

  get extensions(): string {
    return this._extensions;
  }

  get protocol(): string {
    return this._protocol;
  }

  get binaryType(): BinaryType {
    return this._binaryType;
  }

  set binaryType(value: BinaryType) {
    this._binaryType = value;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._readyState !== this.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this._sentMessages.push(typeof data === 'string' ? data : JSON.stringify(data));
    this._lastSentMessage = this._sentMessages[this._sentMessages.length - 1];
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === this.CLOSED) return;
    this._readyState = this.CLOSING;
    setTimeout(() => {
      this._readyState = this.CLOSED;
      const event = new CloseEvent('close', { code, reason, wasClean: true });
      this.dispatchEvent(event);
      if (this.onclose) {
        this.onclose.call(this as unknown as WebSocket, event);
      }
    }, 0);
  }

  // Helper methods for testing
  getSentMessages(): string[] {
    return [...this._sentMessages];
  }

  getLastSentMessage(): string | null {
    return this._lastSentMessage;
  }

  simulateOpen(): void {
    if (this._readyState === this.CONNECTING) {
      this._readyState = this.OPEN;
      const event = new Event('open');
      this.dispatchEvent(event);
      if (this.onopen) {
        this.onopen.call(this as unknown as WebSocket, event);
      }
    }
  }

  simulateError(message: string): void {
    const errorEvent = new ErrorEvent('error', { message });
    this.dispatchEvent(errorEvent);
    if (this.onerror) {
      this.onerror.call(this as unknown as WebSocket, errorEvent);
    }
  }

  simulateMessage(data: string): void {
    const messageEvent = new MessageEvent('message', { data });
    this.dispatchEvent(messageEvent);
    if (this.onmessage) {
      this.onmessage.call(this as unknown as WebSocket, messageEvent);
    }
  }

  setReadyState(state: number): void {
    this._readyState = state;
  }
} 