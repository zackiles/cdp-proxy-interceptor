# Contributing to CDP Proxy Interceptor

This guide will help you get started with contributing to the CDP Proxy Interceptor project.

## Development
Please have Deno 2.0 installed. Ideally, you're also using VS Code or Cursor. If you have cursor, some cursor rules for this project are included - you can read about how to use them at [zackiles/cursor-config](https://github.com/zackiles/cursor-config).

### Project Structure

```
cdp-proxy-interceptor/
├── src/                # Source code
│   ├── chrome_manager.ts   # Chrome process management
│   ├── http_manager.ts     # HTTP request handling
│   ├── plugin_manager.ts   # Plugin system
│   ├── session_manager.ts  # WebSocket session tracking
│   └── ws_manager.ts       # WebSocket handling
├── test/              # Test files
├── plugins/           # Plugin directory
└── scripts/          # Utility scripts
```

### Running Tests

```bash
deno run tests
```

### Using the Logger

The project includes a powerful logging interface that provides consistent formatting, filtering, and log level control. Here's how to use it:

#### Setup and Basic Usage

```typescript
import { Logger } from './src/logger.ts'

// Create a logger with default configuration
const logger = Logger.get('MY_COMPONENT')

// Or configure with optional settings
const configuredLogger = Logger.get('MY_COMPONENT', {
  tags: ['websocket'],  // Optional tags for filtering
  style: '\x1b[35m'    // Optional custom ANSI style for context
})

// Log at different levels - which logs are shown depends on PROXY_LOG_LEVEL
logger.error('Critical failure', { error: new Error('Connection failed') })
logger.warn('Resource running low', { memory: '90%' })
logger.info('Server started', { port: 8080 })
logger.debug('Connection details', { ip: '127.0.0.1' })
logger.log('Standard message')
logger.verbose('Detailed state', { config: { /*...*/ } })
```

#### Advanced Features

1. **Tags for Filtering**
   ```typescript
   // Create logger with tags
   const wsLogger = Logger.get('WEBSOCKET', { tags: ['ws', 'network'] })
   
   // Add tags to existing logger (creates new instance)
   const dbLogger = logger.withTags(['database'])
   
   // Add tags to individual log calls
   logger.info('API request').tags(['api', 'v1'])
   ```

2. **Styling**
   ```typescript
   // Set style during creation
   const styledLogger = Logger.get('API', { style: '\x1b[35m' })
   
   // Add style to existing logger (creates new instance)
   const coloredLogger = logger.withStyle('\x1b[36m')
   ```

3. **Error Handling**
   ```typescript
   // Pass Error object directly
   logger.error(new Error('Connection failed'))
   
   // Include error in metadata
   logger.error('Operation failed', { 
     error: new Error('Timeout'),
     operation: 'fetch'
   })
   
   // Use as catch handler
   fetch('/api').catch(logger.error)
   ```

4. **Metadata**
   ```typescript
   logger.info('Request processed', {
     sessionId: 'abc-123',  // Special field for session tracking
     duration: 150,
     status: 200
   })
   ```

#### Log Levels

Log levels are determined by which log method you call (error, warn, info, etc). Whether those logs are shown is controlled by the `PROXY_LOG_LEVEL` environment variable. Each level includes all logs from levels below it:

```
6 verbose  → All messages
5 log      → Everything except verbose
4 debug    → Errors, warnings, info, and debug
3 info     → Errors, warnings, and info (default)
2 warn     → Errors and warnings
1 error    → Only errors
0 silent   → No output
```

For example:
- Setting `PROXY_LOG_LEVEL=warn` in your .env file shows errors and warnings
- Setting `PROXY_LOG_LEVEL=debug` shows errors, warnings, info, and debug messages
- If not specified, defaults to 'info' which shows errors, warnings, and info messages

#### Instance Configuration

Each logger instance can be configured with tags and styling:

```typescript
// Add tags for filtering
const wsLogger = Logger.get('WEBSOCKET', { tags: ['websocket'] })

// Add custom styling
const styledLogger = Logger.get('API', { style: '\x1b[35m' })

// Combine both
const customLogger = Logger.get('CUSTOM', {
  tags: ['custom'],
  style: '\x1b[35m'
})
```

### Contributing Process

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat(logging): improved logging'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request