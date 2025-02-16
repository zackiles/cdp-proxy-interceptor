import type { CDPCommandRequest, CDPCommandResponse, CDPEvent } from '../src/types.ts'
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts'

export default class MessageModifierPlugin extends BaseCDPPlugin {
    name = 'Advanced Example Plugin'

    override async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    // Ensure we have the required fields according to CDP protocol
    if (!request.id || !request.method) return request

    // Example: Modify parameters of a specific method
    if (request.method === 'Network.setUserAgentOverride') {
      return {
        id: request.id,
        method: request.method,
        params: {
          ...(request.params ?? {}),
          userAgent: `${request.params?.userAgent} (Modified by CDP Proxy)`
        }
      }
    }
    
    // Example: Block a specific method
    if (request.method === 'Security.disable') {
      return null
    }

    return request
  }

  override async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    // Ensure we have the required id field
    if (!response.id) return response

    // Example: Add extra data to successful responses
    if ('result' in response) {
      return {
        id: response.id,
        result: {
          ...response.result,
          _modified: true
        }
      }
    }

    // Pass through error responses unchanged
    if ('error' in response) {
      return response
    }

    return response
  }

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    // Ensure we have the required method field
    if (!event.method) return event

    // Example: Filter Network events
    if (event.method === 'Network.requestWillBeSent' && event.params) {
      const params = event.params as { request: { url: string } }
      // Only allow requests to certain domains
      if (params.request?.url && !params.request.url.includes('allowed-domain.com')) {
        return null
      }
    }

    return event
  }

  /**
   * You can also add a cleanup method, but if you need to do something when the plugin is being disposed
  override cleanup(): Promise<void> | void {
    return Promise.resolve()
  }
  */
} 