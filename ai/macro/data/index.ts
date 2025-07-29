/**
 * Database Macros Index
 * 
 * This module exports database access macros for AI agents to use.
 * Each macro provides structured database query capabilities with:
 * - Connection management via partner settings
 * - Query validation and security
 * - Multiple output formats (JSON, CSV, Markdown, Text)
 * - File export capabilities
 * - Result caching
 * - Comprehensive metadata and logging
 */

import { MsSqlMacroRegistry } from './mssql/macro';
import { PostgresMacroRegistry } from './pgsql/macro';
import { MySqlMacroRegistry } from './mysql/macro';
import { MongoMacroRegistry } from './mongo/macro';

// Export types
export * from './types';

// Export utilities
export * from './utils';

// Export PostgreSQL macro
export { PostgresMacro, PostgresMacroRegistry } from './pgsql/macro';

// Export MySQL macro
export { MySqlMacro, MySqlMacroRegistry } from './mysql/macro';

// Export MSSQL macro
export { MsSqlMacro, MsSqlMacroRegistry } from './mssql/macro';

// Export MongoDB macro
export { MongoMacro, MongoMacroRegistry } from './mongo/macro';

// Export all macro registries for easy registration
export const DatabaseMacros = [
  PostgresMacroRegistry,
  MySqlMacroRegistry, // Uncomment when mysql2 is available
  MsSqlMacroRegistry,
  MongoMacroRegistry
];

export default DatabaseMacros;

/**
 * Database Macro Usage Examples:
 * 
 * 1. PostgreSQL Query:
 * @postgres(connectionId: "prod-db", query: "SELECT * FROM users LIMIT 10", name: "User List", format: "markdown")
 * 
 * 2. MSSQL Query with File Export:
 * @mssql(connectionId: "analytics-db", query: "SELECT COUNT(*) as total FROM orders", name: "Order Count", format: "csv", file: true)
 * 
 * 3. Cached Query:
 * @postgres(connectionId: "prod-db", query: "SELECT * FROM products WHERE active = true", name: "Active Products", cache: true)
 * 
 * Connection Configuration in Partner Settings:
 * {
 *   "name": "prod-db",
 *   "type": "connection",
 *   "variant": "postgres",
 *   "data": {
 *     "host": "localhost",
 *     "port": 5432,
 *     "database": "myapp",
 *     "username": "user",
 *     "password": "password",
 *     "options": {}
 *   }
 * }
 */ 