import type { CDPPlugin, CDPCommandRequest, CDPCommandResponse, CDPEvent } from '../src/types.ts'

export class LoggingPlugin implements CDPPlugin {
  name = 'Simple Example Plugin'

  async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    console.log('[CDP Plugin] Intercepted request:', request)
    if(request.method === 'Browser.getVersion') {
      return null
    }
    return request
  }

  async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    console.log('[CDP Plugin] Intercepted response:', response)
    return response
  }

  async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    console.log('[CDP Plugin] Intercepted event:', event)
    return event
  }
}