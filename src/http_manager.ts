import type { ChromeManager } from './chrome_manager.ts'
import type { ErrorHandler } from './error_handler.ts'
import type { CDPResponse } from './types.ts'
import { CDPErrorType } from './types.ts'
import { CDP_WEBSOCKET_PATHS } from './constants.ts'

/**
 * Manages HTTP requests and responses for the CDP proxy
 */
export class HttpManager {
  constructor(
    private readonly chromeManager: ChromeManager,
    private readonly errorHandler: ErrorHandler,
  ) {}

  /**
   * Handles incoming HTTP requests and proxies them to Chrome
   */
  async handleRequest(
    req: Request,
    url: URL,
    proxyPort: number,
  ): Promise<Response> {
    try {
      const chromePort =
        this.chromeManager.port ??
        (() => {
          throw new Error('Chrome not started')
        })()

      const { method, headers, body } = req
      const chromeUrl = `http://localhost:${chromePort}${url.pathname}${url.search}`
      const chromeResponse = await fetch(new URL(chromeUrl), {
        method,
        headers,
        body,
      })
      const { status, headers: responseHeaders } = chromeResponse
      const responseData = await chromeResponse.json().catch(() => null)

      return responseData && typeof responseData === 'object'
        ? this.createJsonResponse(
            this.rewriteResponse(responseData, `${url.hostname}:${proxyPort}`),
            status,
            responseHeaders,
          )
        : new Response(chromeResponse.body, {
            status,
            headers: responseHeaders,
          })
    } catch (error) {
      return this.createErrorResponse(error)
    }
  }

  private createJsonResponse(data: unknown, status: number, headers: Headers) {
    return new Response(JSON.stringify(data), {
      status,
      headers: new Headers({
        ...Object.fromEntries(headers.entries()),
        'Content-Type': 'application/json',
      }),
    })
  }

  private createErrorResponse(error: unknown) {
    const errorResponse = this.errorHandler.handleError({
      type: CDPErrorType.CONNECTION,
      code: 500,
      message: String(error),
      recoverable: true,
    })

    return this.createJsonResponse({ error: errorResponse }, 500, new Headers())
  }

  /**
   * Rewrites WebSocket URLs in CDP responses
   */
  private rewriteResponse(data: unknown, proxyHost: string): unknown {
    if (!data || typeof data !== 'object') return data
    if (Array.isArray(data))
      return data.map((item) => this.rewriteResponse(item, proxyHost))

    const result = { ...(data as CDPResponse) }

    // Apply WebSocket URL rewrites
    this.rewriteWebSocketUrls(result, proxyHost)
    this.rewriteOtherWebSocketPaths(result, proxyHost)

    return result
  }

  private rewriteWebSocketUrls(result: CDPResponse, proxyHost: string) {
    const rewriteWsUrl = this.createWsUrlRewriter(proxyHost)
    const rewriteWsParam = this.createWsParamRewriter(rewriteWsUrl)

    result.webSocketDebuggerUrl &&= rewriteWsUrl(result.webSocketDebuggerUrl)
    result.devtoolsFrontendUrl &&= rewriteWsParam(result.devtoolsFrontendUrl)
    result.debuggerUrl &&= rewriteWsUrl(result.debuggerUrl)
  }

  private createWsUrlRewriter(proxyHost: string) {
    return (url: string) => {
      try {
        const wsUrlObj = new URL(url)
        wsUrlObj.hostname = 'localhost'
        wsUrlObj.port = proxyHost.split(':')[1]
        return wsUrlObj.toString()
      } catch {
        console.warn('[PROXY] Failed to rewrite WebSocket URL:', url)
        return url
      }
    }
  }

  private createWsParamRewriter(rewriteWsUrl: (url: string) => string) {
    return (url: string) =>
      url.replace(/ws=([^&]+)/g, (_, wsUrl) => {
        const decodedWs = decodeURIComponent(wsUrl)
        const fullWsUrl = decodedWs.startsWith('ws://')
          ? decodedWs
          : `ws://${decodedWs}`
        return `ws=${encodeURIComponent(rewriteWsUrl(fullWsUrl).replace('ws://', ''))}`
      })
  }

  private rewriteOtherWebSocketPaths(result: CDPResponse, proxyHost: string) {
    const rewriteWsUrl = this.createWsUrlRewriter(proxyHost)
    const rewriteWsParam = this.createWsParamRewriter(rewriteWsUrl)

    for (const [key, value] of Object.entries(result)) {
      if (
        typeof value === 'string' &&
        CDP_WEBSOCKET_PATHS.some((path) => value.includes(path))
      ) {
        result[key] = value.startsWith('ws://')
          ? rewriteWsUrl(value)
          : value.includes('ws=')
            ? rewriteWsParam(value)
            : value
      }
    }
  }
}
