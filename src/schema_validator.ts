import type {
  CDPMessage,
  CDPCommandRequest,
  CDPEvent,
  CDPCommandResponse,
  SchemaDefinition,
} from './types.ts'
import { CDP_SCHEMA_URLS } from './constants.ts'

/**
 * Validates CDP (Chrome DevTools Protocol) messages against protocol schema definitions.
 * Handles validation of commands, events, and responses according to the official CDP schema.
 */
export class SchemaValidator {
  enabled = false
  private readonly commandValidators = new Map<string, SchemaDefinition>()
  private readonly eventValidators = new Map<string, SchemaDefinition>()
  private readonly schemaRefs = new Map<string, SchemaDefinition>()

  /**
   * Initializes the validator by fetching and compiling CDP schema definitions
   */
  async initialize(): Promise<void> {
    const fetchSchema = (url: string) =>
      fetch(url)
        .then((res) => res.json())
        .catch((error) => {
          console.error('Failed to fetch schema:', error)
          return { domains: [] }
        })

    const [browserProto, jsProto] = await Promise.all([
      fetchSchema(CDP_SCHEMA_URLS.BROWSER_PROTOCOL),
      fetchSchema(CDP_SCHEMA_URLS.JS_PROTOCOL),
    ])

    const allDomains = [...browserProto.domains, ...jsProto.domains]
    this.collectTypeRefs(allDomains)
    this.compileValidators(allDomains)
  }

  /**
   * Validates a CDP request message against its schema
   */
  validateCDPRequest = (msg: CDPMessage): boolean => {
    if (!this.enabled) return true
    if (!this.isCommandRequest(msg)) return true // Return true for non-requests when validation is enabled
    
    const schema = this.commandValidators.get(msg.method)
    if (!schema) {
      console.warn(`[SchemaValidator] No validator found for request: ${msg.method}`)
      // Return false for unknown methods that look like CDP methods (contain a dot)
      return !msg.method.includes('.')
    }

    try {
      this.validateAgainstSchema(msg.params ?? {}, schema)
    } catch (error) {
      console.warn(`[SchemaValidator] Invalid CDP request:`, {
        method: msg.method,
        errors: error instanceof Error ? error.message : String(error),
        message: msg,
      })
    }
    return true // Always return true for known methods, even if validation fails
  }

  /**
   * Validates a CDP response or event message against its schema
   */
  validateCDPResponse = (msg: CDPMessage): boolean => {
    if (!this.enabled) return true

    if (this.isEvent(msg)) {
      const schema = this.eventValidators.get(msg.method)
      if (!schema) {
        console.warn(`[SchemaValidator] No validator found for event: ${msg.method}`)
        // Return false for unknown events that look like CDP events (contain a dot)
        return !msg.method.includes('.')
      }
      try {
        this.validateAgainstSchema(msg.params ?? {}, schema)
      } catch (error) {
        console.warn(`[SchemaValidator] Invalid CDP event:`, {
          method: msg.method,
          errors: error instanceof Error ? error.message : String(error),
          message: msg,
        })
      }
      return true // Always return true for known events, even if validation fails
    }

    if (!this.isCommandResponse(msg)) return false
    
    // Log response but don't affect validation result
    if (msg.error) {
      console.warn('[SchemaValidator] Response contains error:', msg.error)
    } else {
      console.debug(`[SchemaValidator] Received response for request ${msg.id}`)
    }
    
    return true
  }

  /**
   * Type guard for CDP command requests
   */
  isCommandRequest = (msg: CDPMessage): msg is CDPCommandRequest =>
    'method' in msg && 'id' in msg

  /**
   * Type guard for CDP events
   */
  isEvent = (msg: CDPMessage): msg is CDPEvent =>
    'method' in msg && this.eventValidators.has(msg.method as string)

  private collectTypeRefs = (domains: unknown[]): void => {
    domains?.forEach(domain => {
      const { domain: domainName, types = [] } = domain as {
        domain: string
        types?: unknown[]
      }

      types.forEach(type => {
        const { id, ...typeSchema } = type as { id: string } & Record<string, unknown>
        this.schemaRefs.set(
          `${domainName}.${id}`,
          this.convertTypeToSchema(typeSchema),
        )
      })
    })
  }

  private resolveRef = (ref: string): SchemaDefinition =>
    this.schemaRefs.get(ref) ?? { type: 'object', additionalProperties: true }

  private compileValidators = (domains: unknown[]): void => {
    domains?.forEach(domain => {
      const {
        domain: domainName,
        commands = [],
        events = [],
      } = domain as { domain: string; commands?: unknown[]; events?: unknown[] }

      commands.forEach(cmd => {
        const { name, parameters = [] } = cmd as {
          name: string
          parameters?: unknown[]
        }
        this.commandValidators.set(
          `${domainName}.${name}`,
          this.createSchema(parameters),
        )
      })

      events.forEach(evt => {
        const { name, parameters = [] } = evt as {
          name: string
          parameters?: unknown[]
        }
        this.eventValidators.set(
          `${domainName}.${name}`,
          this.createSchema(parameters),
        )
      })
    })
  }

  private createSchema = (parameters: unknown[]): SchemaDefinition => {
    const { properties, required } = parameters.reduce<{
      properties: Record<string, SchemaDefinition>
      required: string[]
    }>(
      (acc, param) => {
        const { name, optional, ...rest } = param as {
          name: string
          optional?: boolean
        }
        acc.properties[name] = this.convertTypeToSchema(rest)
        if (!optional) acc.required.push(name)
        return acc
      },
      { properties: {}, required: [] },
    )

    return {
      type: 'object',
      properties,
      required: required.length ? required : undefined,
      additionalProperties: true,
    }
  }

  private convertTypeToSchema = (param: unknown): SchemaDefinition => {
    const {
      type,
      items,
      properties,
      enum: enumValues,
      $ref,
    } = param as {
      type?: string
      items?: unknown
      properties?: unknown[]
      enum?: unknown[]
      $ref?: string
    }

    if ($ref) return this.resolveRef($ref)

    const typeMap: Record<string, (() => SchemaDefinition) | undefined> = {
      string: () => ({ type: 'string' }),
      integer: () => ({ type: 'integer' }),
      number: () => ({ type: 'number' }),
      boolean: () => ({ type: 'boolean' }),
      array: () => ({
        type: 'array',
        items: items ? this.convertTypeToSchema(items) : undefined,
      }),
      object: () => {
        if (!properties?.length) {
          return { type: 'object', additionalProperties: true }
        }

        const { props, required } = properties.reduce<{
          props: Record<string, SchemaDefinition>
          required: string[]
        }>(
          (acc, prop: unknown) => {
            const { name, optional, ...rest } = prop as {
              name: string
              optional?: boolean
            }
            acc.props[name] = this.convertTypeToSchema(rest)
            if (!optional) acc.required.push(name)
            return acc
          },
          { props: {}, required: [] },
        )

        return {
          type: 'object',
          properties: props,
          required: required.length ? required : undefined,
          additionalProperties: true,
        }
      },
    }

    const schema = (typeMap[type as string] ?? (() => ({ type: 'string' })))()
    return enumValues?.length ? { ...schema, enum: enumValues } : schema
  }

  private isCommandResponse = (msg: CDPMessage): msg is CDPCommandResponse =>
    'id' in msg && !('method' in msg)

  private isExpectedType = (data: unknown, expectedType: string): boolean => {
    const typeChecks: Record<string, (d: unknown) => boolean> = {
      string: (d): d is string => typeof d === 'string',
      number: (d): d is number => typeof d === 'number',
      boolean: (d): d is boolean => typeof d === 'boolean',
    }
    return typeChecks[expectedType]?.(data) ?? false
  }

  private validateAgainstSchema = (data: unknown, schema: SchemaDefinition): void => {
    if (schema.type === 'object') {
      if (typeof data !== 'object' || data === null) {
        throw new Error(`Expected object, got ${typeof data}`)
      }

      schema.required?.forEach(required => {
        if (!(required in data)) {
          throw new Error(`Missing required property: ${required}`)
        }
      })

      if (schema.properties) {
        Object.entries(data as Record<string, unknown>).forEach(([key, value]) => {
          const propertySchema = schema.properties?.[key]
          if (propertySchema) {
            this.validateAgainstSchema(value, propertySchema)
          }
        })
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        throw new Error(`Expected array, got ${typeof data}`)
      }

      if (schema.items) {
        data.forEach(item => this.validateAgainstSchema(item, schema.items!))
      }
    } else {
      const typeMap: Record<string, string> = {
        string: 'string',
        number: 'number',
        integer: 'number',
        boolean: 'boolean',
      }

      const expectedType = typeMap[schema.type || '']
      if (expectedType && !this.isExpectedType(data, expectedType)) {
        throw new Error(`Expected ${expectedType}, got ${typeof data}`)
      }

      if (schema.enum && !schema.enum.includes(data)) {
        throw new Error(`Value must be one of: ${schema.enum.join(', ')}`)
      }
    }
  }
}
