import type { CDPCommandRequest, CDPCommandResponse, CDPEvent } from '../src/types.ts'
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts'

export class LoggingPlugin extends BaseCDPPlugin {
  name = 'Simple Example Plugin'

  override async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    console.log('[CDP Plugin] Intercepted request:', request)
    return request
  }

  override async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    console.log('[CDP Plugin] Intercepted response:', response)
    return response
  }

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    console.log('[CDP Plugin] Intercepted event:', event)
    return event
  }
  
  /**
   * You can also add a cleanup method, but if you need to do something when the plugin is being disposed
  override cleanup(): Promise<void> | void {
    return Promise.resolve()
  }
  */
}