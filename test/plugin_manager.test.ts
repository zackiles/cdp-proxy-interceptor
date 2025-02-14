import './test_setup.ts'
import { assertExists, assertEquals } from 'jsr:@std/assert'
import { PluginManager } from '../src/plugin_manager.ts'
import { ErrorHandler } from '../src/error_handler.ts'
import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from '../src/types.ts'

Deno.test('PluginManager', async (t) => {
  const errorHandler = new ErrorHandler()
  const pluginManager = new PluginManager(errorHandler)

  await t.step('should register and unregister plugins', () => {
    const plugin: CDPPlugin = {
      name: 'test-plugin',
      onRequest: async (req) => req,
    }

    pluginManager.registerPlugin(plugin)
    assertEquals(pluginManager.hasPlugins(), true)
    assertEquals(pluginManager.getPlugins().length, 1)

    pluginManager.unregisterPlugin(plugin)
    assertEquals(pluginManager.hasPlugins(), false)
    assertEquals(pluginManager.getPlugins().length, 0)
  })

  await t.step('should process requests through plugins', async () => {
    const plugin: CDPPlugin = {
      name: 'request-plugin',
      onRequest: async (req) => ({
        ...req,
        params: { ...req.params, modified: true },
      }),
    }

    pluginManager.registerPlugin(plugin)

    const request: CDPCommandRequest = {
      id: 1,
      method: 'test',
      params: { original: true },
    }

    const result = await pluginManager.processRequest(request)
    assertExists(result)
    assertEquals(result.params?.modified, true)
    assertEquals(result.params?.original, true)

    pluginManager.unregisterPlugin(plugin)
  })

  await t.step('should process responses through plugins', async () => {
    const plugin: CDPPlugin = {
      name: 'response-plugin',
      onResponse: async (res) => ({
        ...res,
        result: { ...res.result, modified: true },
      }),
    }

    pluginManager.registerPlugin(plugin)

    const response: CDPCommandResponse = {
      id: 1,
      result: { original: true },
    }

    const result = await pluginManager.processResponse(response)
    assertExists(result)
    assertEquals(result.result?.modified, true)
    assertEquals(result.result?.original, true)

    pluginManager.unregisterPlugin(plugin)
  })

  await t.step('should process events through plugins', async () => {
    const plugin: CDPPlugin = {
      name: 'event-plugin',
      onEvent: async (event) => ({
        ...event,
        params: { ...event.params, modified: true },
      }),
    }

    pluginManager.registerPlugin(plugin)

    const event: CDPEvent = {
      method: 'test.event',
      params: { original: true },
    }

    const result = await pluginManager.processEvent(event)
    assertExists(result)
    assertEquals(result.params?.modified, true)
    assertEquals(result.params?.original, true)

    pluginManager.unregisterPlugin(plugin)
  })

  await t.step('should handle plugin errors gracefully', async () => {
    const plugin: CDPPlugin = {
      name: 'error-plugin',
      onRequest: async () => {
        throw new Error('Plugin error')
      },
    }

    pluginManager.registerPlugin(plugin)

    const request: CDPCommandRequest = {
      id: 1,
      method: 'test',
    }

    // Should not throw and return the original request
    const result = await pluginManager.processRequest(request)
    assertExists(result)
    assertEquals(result, request)

    pluginManager.unregisterPlugin(plugin)
  })

  await t.step('should handle plugin message blocking', async () => {
    const plugin: CDPPlugin = {
      name: 'blocking-plugin',
      onRequest: async () => null, // Block all requests
      onResponse: async () => null, // Block all responses
      onEvent: async () => null, // Block all events
    }

    pluginManager.registerPlugin(plugin)

    const request: CDPCommandRequest = {
      id: 1,
      method: 'test',
    }

    const response: CDPCommandResponse = {
      id: 1,
      result: {},
    }

    const event: CDPEvent = {
      method: 'test.event',
    }

    // All messages should be blocked (return null)
    assertEquals(await pluginManager.processRequest(request), null)
    assertEquals(await pluginManager.processResponse(response), null)
    assertEquals(await pluginManager.processEvent(event), null)

    pluginManager.unregisterPlugin(plugin)
  })

  await t.step('should clear all plugins', () => {
    const plugins: CDPPlugin[] = [
      { name: 'plugin1', onRequest: async (req) => req },
      { name: 'plugin2', onResponse: async (res) => res },
      { name: 'plugin3', onEvent: async (event) => event },
    ]

    for (const plugin of plugins) {
      pluginManager.registerPlugin(plugin)
    }
    assertEquals(pluginManager.hasPlugins(), true)
    assertEquals(pluginManager.getPlugins().length, 3)

    pluginManager.clearPlugins()
    assertEquals(pluginManager.hasPlugins(), false)
    assertEquals(pluginManager.getPlugins().length, 0)
  })
})
