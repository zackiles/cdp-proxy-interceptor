// Export types needed by consumers
export type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
  Session,
} from './types.ts'

// Export main functionality for starting/stopping proxy
export { default as startProxy } from './main.ts'
export { setupSignalHandlers } from './main.ts'
