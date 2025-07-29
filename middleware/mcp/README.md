# Reactory MCP Server Implementation

## Overview

The Reactory MCP (Model Context Protocol) server provides a standardized interface for AI clients to interact with Reactory's AI capabilities, tools, and resources. This implementation follows the MCP specification and provides enhanced stability and capabilities.

## Architecture

### Core Components

1. **ReactorServer.ts** - Main SSE server implementation
2. **Handlers/** - Individual RPC method handlers
3. **rpcUtils.ts** - Shared utilities and validation
4. **types.ts** - MCP protocol type definitions
5. **ReactoryMCPMiddleware.ts** - Express middleware integration

### Session Management

- **Automatic cleanup**: Stale sessions are automatically cleaned up every 5 minutes
- **Activity tracking**: Sessions track last activity time
- **Heartbeat monitoring**: Regular heartbeat to detect connection issues
- **Resource cleanup**: Proper cleanup of intervals and timeouts

### Security Features

- **Input validation**: All inputs are validated and sanitized
- **Request size limits**: Prevents DoS attacks (1MB limit)
- **Authentication**: JWT-based authentication required
  - Authenticate via /login route against the server url using standard BTOA functionality to get a new JWT token
- **XSS prevention**: Input sanitization for string values
- **Error handling**: Comprehensive error handling without information leakage

## Improvements Made

### 1. Session Management
- ✅ Fixed typo in session type definition (`intialized` → `initialized`)
- ✅ Added automatic session cleanup with configurable timeouts
- ✅ Implemented activity tracking for session management
- ✅ Added proper resource cleanup on session termination
- ✅ Enhanced error handling for SSE connections

### 2. Error Handling & Stability
- ✅ Comprehensive try-catch blocks throughout the codebase
- ✅ Proper JSON-RPC 2.0 error codes and messages
- ✅ Request validation with detailed error messages
- ✅ Request size limits to prevent DoS attacks
- ✅ Graceful handling of connection errors

### 3. MCP Protocol Compliance
- ✅ Enhanced capability declarations in initialize handler
- ✅ Progress notifications support
- ✅ Proper JSON-RPC 2.0 formatting
- ✅ Support for experimental capabilities
- ✅ Comprehensive server instructions

### 4. Security Enhancements
- ✅ Input sanitization utilities
- ✅ Request size validation
- ✅ XSS prevention in string inputs
- ✅ Safe JSON serialization with error handling
- ✅ Authentication validation in all handlers

### 5. Monitoring & Debugging
- ✅ Enhanced logging throughout the codebase
- ✅ Progress notification support for long-running operations
- ✅ Session count monitoring
- ✅ Detailed error logging with context

## Usage

### Starting the MCP Server

The MCP server is automatically started when the Reactory Express server initializes. It provides two main endpoints:

1. **GET /reactor-mcp/sse** - Establishes SSE connection
2. **POST /reactor-mcp/messages** - Handles RPC messages

### Client Integration

```javascript
// Example client usage
const eventSource = new EventSource('/reactor-mcp/sse');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('MCP Response:', data);
};

// Send RPC request
fetch('/reactor-mcp/messages?sessionId=YOUR_SESSION_ID', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  })
});
```

## Configuration

### Environment Variables

- `SERVER_ID` - Server identifier (default: "Reactory MCP Server")
- `OPENAI_API_KEY` - OpenAI API key for tool execution
- `OPENAI_ORG` - OpenAI organization ID

### Session Configuration

```typescript
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_INTERVAL = 10 * 1000;   // 10 seconds
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
```

## Supported MCP Methods

### Core Methods
- `initialize` - Server initialization and capability negotiation
- `tools/list` - List available tools
- `tools/call` - Execute a tool
- `prompts/list` - List available prompts
- `resources/list` - List available resources
- `resources/get` - Get resource content

### Notification Methods
- `notifications/initialized` - Client initialization complete
- `notifications/heartbeat` - Connection heartbeat
- `notifications/close` - Close connection
- `notifications/error` - Error notification
- `notifications/progress` - Progress updates (supported)

## Error Codes

The server uses standard JSON-RPC 2.0 error codes:

- `-32700` - Parse error
- `-32600` - Invalid request
- `-32601` - Method not found
- `-32602` - Invalid params
- `-32603` - Internal error

## Testing

Use the provided test file `mcp.test.http` to test the MCP server:

```bash
# Test SSE connection
GET http://localhost:4000/reactor-mcp/sse

# Test tool listing
POST http://localhost:4000/reactor-mcp/messages?sessionId=YOUR_SESSION_ID
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

## Future Enhancements

### Planned Improvements

1. **Resource Management**
   - File system resource provider
   - Database resource provider
   - Real-time resource updates

2. **Advanced Tool Features**
   - Tool parameter validation
   - Tool execution timeouts
   - Tool result caching

3. **Monitoring & Analytics**
   - Request/response metrics
   - Performance monitoring
   - Usage analytics

4. **Security Enhancements**
   - Rate limiting
   - Request signing
   - Audit logging

5. **Protocol Extensions**
   - Custom MCP extensions
   - Plugin system
   - Third-party integrations

### Recommended Next Steps

1. **Implement Resource Providers**
   ```typescript
   // Example resource provider
   class FileSystemResourceProvider {
     async listResources(): Promise<Resource[]> {
       // Implementation
     }
     
     async getResource(uri: string): Promise<ResourceContents> {
       // Implementation
     }
   }
   ```

2. **Add Rate Limiting**
   ```typescript
   import rateLimit from 'express-rate-limit';
   
   const mcpRateLimit = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 minutes
     max: 100 // limit each IP to 100 requests per windowMs
   });
   ```

3. **Implement Request Caching**
   ```typescript
   class MCPRequestCache {
     private cache = new Map<string, any>();
     
     async get(key: string): Promise<any> {
       // Implementation
     }
     
     async set(key: string, value: any, ttl: number): Promise<void> {
       // Implementation
     }
   }
   ```

## Troubleshooting

### Common Issues

1. **Session not found errors**
   - Check if session has timed out
   - Verify sessionId is correct
   - Check server logs for cleanup messages

2. **Tool execution failures**
   - Verify ReactorMacroService is available
   - Check tool permissions and roles
   - Review tool parameter validation

3. **SSE connection issues**
   - Check authentication token
   - Verify CORS settings
   - Review network connectivity

### Debug Mode

Enable debug logging by setting the log level:

```typescript
context.debug("[MCP] Debug message", data, 'handlerName');
```

## Contributing

When contributing to the MCP implementation:

1. Follow the existing code style and patterns
2. Add comprehensive error handling
3. Include proper TypeScript types
4. Add tests for new functionality
5. Update this documentation

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) 