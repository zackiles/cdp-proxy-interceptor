import './test_setup.ts'
import { assertEquals } from 'jsr:@std/assert'
import { SchemaValidator } from '../src/schema_validator.ts'
import { CDPErrorType } from '../src/types.ts'

Deno.test('SchemaValidator', async (t) => {
  const validator = new SchemaValidator()

  await t.step('should initialize with CDP schemas', async () => {
    await validator.initialize()
    // After initialization, the validator should have compiled schemas
    const validRequest = {
      id: 1,
      method: 'Page.navigate',
      params: {
        url: 'https://example.com',
      },
    }
    validator.enabled = true
    const result = validator.validateCDPRequest(validRequest)
    assertEquals(result, true)
  })

  await t.step('should validate CDP requests', async () => {
    validator.enabled = true

    // Test valid request
    const validRequest = {
      id: 1,
      method: 'Page.navigate',
      params: {
        url: 'https://example.com',
      },
    }
    assertEquals(validator.validateCDPRequest(validRequest), true)

    // Test invalid request (wrong parameter type)
    const invalidRequest = {
      id: 1,
      method: 'Page.navigate',
      params: {
        url: 123, // Should be a string
      },
    }
    assertEquals(validator.validateCDPRequest(invalidRequest), true) // Always returns true, but logs warning
  })

  await t.step('should validate CDP responses', async () => {
    validator.enabled = true

    // Test valid response
    const validResponse = {
      id: 1,
      result: {},
    }
    assertEquals(validator.validateCDPResponse(validResponse), true)

    // Test error response
    const errorResponse = {
      id: 1,
      error: {
        type: CDPErrorType.PROTOCOL,
        code: -32000,
        message: 'Not implemented',
        recoverable: true,
      },
    }
    assertEquals(validator.validateCDPResponse(errorResponse), true)
  })

  await t.step('should handle validation errors', async () => {
    validator.enabled = true

    // Test with completely invalid message
    const invalidMessage = {
      id: 1,
      method: 'Invalid.method',
      params: {},
    }
    assertEquals(validator.validateCDPRequest(invalidMessage), false) // Should return false for invalid messages
    assertEquals(validator.validateCDPResponse(invalidMessage), false) // Should return false for invalid messages
  })

  await t.step('should respect enabled flag', async () => {
    validator.enabled = false

    // Even invalid messages should pass when validation is disabled
    const invalidMessage = {
      id: 1,
      method: 'Invalid.method',
      params: {},
    }
    assertEquals(validator.validateCDPRequest(invalidMessage), true) // Should pass when validation is disabled
    assertEquals(validator.validateCDPResponse(invalidMessage), true) // Should pass when validation is disabled
  })
})
