import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from './types.ts'

/**
 * Base class for CDP plugins, providing common functionality.
 */
export abstract class BaseCDPPlugin implements CDPPlugin {
  abstract name: string

  // These will be injected by the PluginManager
  sendCDPCommand!: (
    endpoint: string,
    proxySessionId: string,
    message: CDPCommandRequest,
  ) => Promise<CDPCommandResponse>
  emitClientEvent!: (
    proxySessionId: string,
    event: CDPEvent | CDPCommandResponse,
  ) => Promise<void>

  onRequest?(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    return Promise.resolve(request);
  }
  onResponse?(response: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    return Promise.resolve(response);
  }
  onEvent?(event: CDPEvent): Promise<CDPEvent | null> {
    return Promise.resolve(event);
  }
  cleanup?(): Promise<void> {
    return Promise.resolve();
  }
} 