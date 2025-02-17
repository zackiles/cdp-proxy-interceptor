import type { BROWSER_OS_CONFIGS } from './constants.ts'
import type { ErrorHandler } from './error_handler.ts'
import type { ChromeManager } from './chrome_manager.ts'
import type { SessionManager } from './session_manager.ts'
import type { SchemaValidator } from './schema_validator.ts'
import type { PluginManager } from './plugin_manager.ts'
import type { WebSocketManager } from './websocket_manager.ts'
import type { HttpManager } from './http_manager.ts'

export interface BufferConfig {
  cleanupInterval: number // Milliseconds between cleanup runs
  warningThreshold: number // Bytes before memory warning
  maxSize: number // Maximum bytes per session
  maxBufferSize: number // Maximum size in bytes for a session's buffer
}

export interface Session {
  id: string
  clientSocket: WebSocket
  chromeSocket: WebSocket
  chromeWsUrl: string
  active: boolean
  createdAt: number
}

export interface CDPError {
  type: CDPErrorType
  code: number
  message: string
  details?: unknown
  recoverable: boolean
}

export enum CDPErrorType {
  CONNECTION = 'connection',
  PROTOCOL = 'protocol',
  VALIDATION = 'validation',
  RESOURCE = 'resource',
  PLUGIN = 'plugin',
}

export type CDPMessage = CDPCommandRequest | CDPCommandResponse | CDPEvent

export interface CDPCommandRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPCommandResponse {
  id: number
  result?: Record<string, unknown>
  error?: CDPError
  sessionId?: string
}

export interface CDPEvent {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPPlugin {
  name: string;
  sendCDPCommand?: (
    endpoint: string,
    proxySessionId: string,
    message: CDPCommandRequest,
  ) => Promise<CDPCommandResponse>;
  emitClientEvent?: (
    proxySessionId: string,
    event: CDPEvent,
  ) => Promise<void>;
  onRequest?: (
    request: CDPCommandRequest,
  ) => Promise<CDPCommandRequest | null>;
  onResponse?: (
    response: CDPCommandResponse,
  ) => Promise<CDPCommandResponse | null>;
  onEvent?: (event: CDPEvent) => Promise<CDPEvent | null>;
  cleanup?: () => Promise<void>;
  _state?: { cleaning?: boolean; cleanupStarted?: number };
}

export interface SchemaDefinition {
  type?: string
  properties?: Record<string, SchemaDefinition>
  required?: string[]
  items?: SchemaDefinition
  enum?: unknown[]
  additionalProperties?: boolean
}

export interface ChromiumPaths {
  executablePath: string
  directory: string
  osConfig: (typeof BROWSER_OS_CONFIGS)[keyof typeof BROWSER_OS_CONFIGS]
}

// Base type for debugger responses
export interface BaseDebuggerResponse {
  webSocketDebuggerUrl?: string
  [key: string]: unknown
}

// Chrome-specific response extending base
export interface ChromeResponse extends BaseDebuggerResponse {
  Browser?: string
  'Protocol-Version'?: string
  'User-Agent'?: string
  'V8-Version'?: string
  'WebKit-Version'?: string
}

// CDP-specific response extending base
export interface CDPResponse extends BaseDebuggerResponse {
  devtoolsFrontendUrl?: string
  debuggerUrl?: string
}

export interface ProxyComponents {
  errorHandler: ErrorHandler
  chromeManager: ChromeManager
  sessionManager: SessionManager
  schemaValidator: SchemaValidator
  pluginManager: PluginManager
  wsManager: WebSocketManager
  httpManager: HttpManager
}

// WebSocket Manager Types
export type WebSocketSource = 'client' | 'chrome'
export type WebSocketConnectionStatus = 'CONNECTED' | 'DISCONNECTED'

export interface WebSocketConnectionState {
  clientReady: boolean
  chromeReady: boolean
  clientSocket: WebSocket
  chromeSocket: WebSocket
}

export interface WebSocketPendingMessage {
  source: WebSocketSource
  message: string
}
