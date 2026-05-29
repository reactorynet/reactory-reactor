# Database Macros for AI Agents

This module provides database access macros for AI agents to execute SQL queries against various database systems with structured results and comprehensive metadata.

## Available Database Macros

### List Data Connections (`@listDataConnections`)
- **File**: `connections/macro.ts`
- **Purpose**: Lists partner-configured data connections available to the current user/agent.
- **Security**: If a connection setting defines `roles`, access is filtered using runtime role checks.
- **Output**: Sanitized connection metadata (`connectionId`, `variant`, `host`, `port`, `database`, optional roles/description). Passwords are never returned.

### PostgreSQL (`@postgres`)
- **File**: `pgsql/macro.ts`
- **Dependencies**: `pg` package
- **Variant**: `postgres`

### MySQL (`@mysql`)
- **File**: `mysql/macro.ts`
- **Dependencies**: `mysql2` package (currently disabled due to missing dependency)
- **Variant**: `mysql`

### Microsoft SQL Server (`@mssql`)
- **File**: `mssql/macro.ts`
- **Dependencies**: `mssql` package
- **Variant**: `mssql`

### MongoDB (`@mongo`)
- **File**: `mongo/macro.ts`
- **Dependencies**: `mongodb` package
- **Variant**: `mongo`

## Common Parameters

All database macros accept the following parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionId` | string | Yes | Connection ID from partner settings |
| `query` | string | No* | SQL query to execute (SELECT only for security) |
| `name` | string | Yes | Name for the operation |
| `collection` | string | No* | MongoDB collection name (required for MongoDB) |
| `pipeline` | array | No* | MongoDB aggregation pipeline |
| `filter` | object | No* | MongoDB find filter |
| `projection` | object | No | MongoDB projection (fields to return) |
| `sort` | object | No | MongoDB sort options |
| `limit` | number | No | MongoDB limit |
| `skip` | number | No | MongoDB skip |
| `format` | string | No | Output format: `json`, `csv`, `markdown`, `text` (default: `json`) |
| `file` | boolean | No | Whether to save output to file (default: `false`) |
| `cache` | boolean | No | Whether to cache results (default: `true`) |

*For MongoDB: Either `query`, `pipeline`, or `filter` is required

## Connection Configuration

Database connections are configured in partner settings with the following structure:

```json
{
  "name": "prod-db",
  "type": "connection",
  "variant": "postgres",
  "data": {
    "host": "localhost",
    "port": 5432,
    "database": "myapp",
    "username": "user",
    "password": "password",
    "options": {}
  }
}
```

### Supported Variants
- `postgres` - PostgreSQL database
- `mysql` - MySQL database
- `mssql` - Microsoft SQL Server
- `mongo` - MongoDB
- `redis` - Redis (future)

## Usage Examples

### Basic PostgreSQL Query
```
@postgres(connectionId: "prod-db", query: "SELECT * FROM users LIMIT 10", name: "User List", format: "markdown")
```

### MSSQL Query with File Export
```
@mssql(connectionId: "analytics-db", query: "SELECT COUNT(*) as total FROM orders", name: "Order Count", format: "csv", file: true)
```

### Cached Query
```
@postgres(connectionId: "prod-db", query: "SELECT * FROM products WHERE active = true", name: "Active Products", cache: true)
```

### MongoDB Find Query
```
@mongo(connectionId: "mongo-db", collection: "users", filter: {"active": true}, name: "Active Users", format: "markdown")
```

### MongoDB Aggregation Pipeline
```
@mongo(connectionId: "mongo-db", collection: "orders", pipeline: [{"$group": {"_id": "$status", "count": {"$sum": 1}}}], name: "Order Status Count", format: "json")
```

### MongoDB Query with Projection and Sort
```
@mongo(connectionId: "mongo-db", collection: "products", filter: {"category": "electronics"}, projection: {"name": 1, "price": 1, "_id": 0}, sort: {"price": -1}, limit: 10, name: "Top Electronics", format: "csv", file: true)
```

## Security Features

### Query Validation
- **SQL Databases**: Only SELECT queries are allowed
- **MongoDB**: Only read operations (find, aggregate) are allowed
- Dangerous operations are blocked (DROP, DELETE, UPDATE, etc.)
- SQL injection protection through parameterized queries
- MongoDB query validation for security

### Connection Security
- Connections are retrieved from partner settings
- Variant validation ensures correct database type
- Connection pooling for efficient resource management

### Audit Logging
- All queries are logged with user information
- Execution times and row counts are tracked
- Error conditions are logged for debugging

## Output Formats

### JSON
```json
[
  {"id": 1, "name": "John Doe", "email": "john@example.com"},
  {"id": 2, "name": "Jane Smith", "email": "jane@example.com"}
]
```

### CSV
```csv
id,name,email
1,John Doe,john@example.com
2,Jane Smith,jane@example.com
```

### Markdown
```markdown
# User List

| id | name | email |
|---|---|---|
| 1 | John Doe | john@example.com |
| 2 | Jane Smith | jane@example.com |
```

### Text
```
User List:

Row 1:
  id: 1
  name: John Doe
  email: john@example.com

Row 2:
  id: 2
  name: Jane Smith
  email: jane@example.com
```

## Caching

- Results are cached for 5 minutes by default
- Cache keys are generated using MD5 hash of connection, query, and name
- Cached results include execution time and metadata
- Cache can be disabled by setting `cache: false`

## File Export

When `file: true` is specified:
- Output is saved to user's profile folder: `~/.reactory/exports/{userId}/`
- Filename format: `{name}_{timestamp}.{extension}`
- Supported extensions: `.json`, `.csv`, `.md`, `.txt`

## Structured Response Format

All database macros return structured responses following the standard format:

```typescript
{
  success: boolean;
  error?: string;
  data?: {
    name: string;
    query: string;
    connectionId: string;
    variant: string;
    result: DatabaseQueryResult;
    formattedOutput: string;
    format: string;
    savedToFile: boolean;
    filePath?: string;
    cached: boolean;
    cacheKey?: string;
  };
  tool: string;
  params: DatabaseMacroProps;
  metadata?: {
    executionTime?: number;
    timestamp: Date;
    user?: string;
    connectionId: string;
    variant: string;
    queryLength: number;
    rowCount?: number;
    columnCount?: number;
  };
  instructions?: string;
}
```

## State Variables

Each macro stores its last execution in chat state:
- `lastPostgresQuery` - Last PostgreSQL query
- `lastMySqlQuery` - Last MySQL query  
- `lastMsSqlQuery` - Last MSSQL query
- `lastMongoQuery` - Last MongoDB query
- `{cacheKey}` - Cached results for specific queries

## Error Handling

Common error scenarios:
- **Connection not found**: Connection ID doesn't exist in partner settings
- **Wrong variant**: Connection exists but is wrong database type
- **Query validation failed**: Query contains dangerous operations
- **Database connection failed**: Network or authentication issues
- **Query execution failed**: SQL syntax errors or permission issues

## Dependencies

### Required Packages
- `pg` - PostgreSQL client
- `mssql` - Microsoft SQL Server client
- `mysql2` - MySQL client (when available)
- `mongodb` - MongoDB client

### Optional Packages
- `crypto` - For cache key generation (Node.js built-in)

## Future Enhancements

- Redis support
- Connection pooling configuration
- Query timeout settings
- Result pagination
- Stored procedure support
- Transaction support
- Query templates
- Result transformation
- Export to cloud storage
- MongoDB write operations (insert, update, delete) with proper validation 