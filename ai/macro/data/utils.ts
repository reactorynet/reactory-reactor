import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { DatabaseMacroProps, DatabaseConnection, DatabaseQueryResult, OutputFormat } from './types';
import logger from '@reactory/server-core/logging';

/**
 * Get database connection from partner settings
 */
export const getDatabaseConnection = (
  connectionId: string, 
  partner: any
): DatabaseConnection | null => {
  try {
    if (!partner?.settings || !Array.isArray(partner.settings)) {
      return null;
    }

    const connectionSetting = partner.settings.find(
      (setting: any) => 
        setting.name === connectionId && 
        setting.settingType === 'connection'
    );

    if (!connectionSetting || !connectionSetting.data) {
      return null;
    }

    return connectionSetting.data;
  } catch (error) {
    logger.error(`Error getting database connection ${connectionId}:`, error);
    return null;
  }
};

/**
 * Format query results based on output format
 */
export const formatQueryResults = (
  result: DatabaseQueryResult,
  format: OutputFormat,
  name: string
): string => {
  try {
    switch (format) {
      case 'json':
        return JSON.stringify(result.rows, null, 2);
      
      case 'csv':
        if (result.rows.length === 0) return '';
        const headers = result.columns.join(',');
        const rows = result.rows.map(row => 
          result.columns.map(col => {
            const value = row[col];
            // Escape commas and quotes in CSV
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          }).join(',')
        );
        return [headers, ...rows].join('\n');
      
      case 'markdown':
        if (result.rows.length === 0) return `# ${name}\n\nNo results found.`;
        
        const headerRow = `| ${result.columns.join(' | ')} |`;
        const separatorRow = `| ${result.columns.map(() => '---').join(' | ')} |`;
        const dataRows = result.rows.map(row => 
          `| ${result.columns.map(col => row[col] || '').join(' | ')} |`
        );
        
        return `# ${name}\n\n${headerRow}\n${separatorRow}\n${dataRows.join('\n')}`;
      
      case 'text':
        if (result.rows.length === 0) return `${name}: No results found.`;
        
        const lines = [`${name}:`, ''];
        result.rows.forEach((row, index) => {
          lines.push(`Row ${index + 1}:`);
          result.columns.forEach(col => {
            lines.push(`  ${col}: ${row[col] || ''}`);
          });
          lines.push('');
        });
        return lines.join('\n');
      
      default:
        return JSON.stringify(result.rows, null, 2);
    }
  } catch (error) {
    logger.error(`Error formatting query results:`, error);
    return JSON.stringify(result.rows, null, 2);
  }
};

/**
 * Save formatted output to file
 */
export const saveToFile = async (
  content: string,
  name: string,
  format: OutputFormat,
  userId?: string
): Promise<{ success: boolean; filePath?: string; error?: string }> => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '_');
    const extension = format === 'markdown' ? 'md' : format;
    const fileName = `${safeName}_${timestamp}.${extension}`;
    
    // Create user profile folder if it doesn't exist
    const userFolder = path.join(os.homedir(), '.reactory', 'exports', userId || 'default');
    await fs.mkdir(userFolder, { recursive: true });
    
    const filePath = path.join(userFolder, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    
    return { success: true, filePath };
  } catch (error) {
    logger.error(`Error saving file:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

/**
 * Generate cache key for query
 */
export const generateCacheKey = (
  connectionId: string,
  query: string,
  name: string
): string => {
  const hash = require('crypto').createHash('md5')
    .update(`${connectionId}:${query}:${name}`)
    .digest('hex');
  return `db_query_${hash}`;
};

/**
 * Validate SQL query for security
 */
export const validateQuery = (query: string): { valid: boolean; error?: string } => {
  const trimmedQuery = query.trim().toLowerCase();
  
  // Check for dangerous operations
  const dangerousPatterns = [
    /drop\s+table/i,
    /drop\s+database/i,
    /truncate\s+table/i,
    /delete\s+from\s+.*\s+where\s+1\s*=\s*1/i,
    /update\s+.*\s+set\s+.*\s+where\s+1\s*=\s*1/i,
    /alter\s+table/i,
    /create\s+table/i,
    /create\s+database/i,
    /grant\s+/i,
    /revoke\s+/i,
    /backup\s+database/i,
    /restore\s+database/i
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmedQuery)) {
      return { 
        valid: false, 
        error: `Query contains potentially dangerous operation: ${pattern.source}` 
      };
    }
  }

  // Ensure query starts with SELECT
  if (!trimmedQuery.startsWith('select ')) {
    return { 
      valid: false, 
      error: 'Only SELECT queries are allowed for security reasons' 
    };
  }

  return { valid: true };
};

/**
 * Create database query result object
 */
export const createQueryResult = (
  raw: any,
  executionTime: number,
  success: boolean,
  error?: string
): DatabaseQueryResult => {
  try {
    if (!success) {
      return {
        executionTime,
        rowCount: 0,
        columns: [],
        rows: [],
        raw,
        success: false,
        error
      };
    }

    // Handle different database result formats
    let rows: Record<string, any>[] = [];
    let columns: string[] = [];

    if (raw && Array.isArray(raw)) {
      // Array of objects
      rows = raw;
      if (raw.length > 0) {
        columns = Object.keys(raw[0]);
      }
    } else if (raw && raw.rows && Array.isArray(raw.rows)) {
      // PostgreSQL/Node.js driver format
      rows = raw.rows;
      if (raw.fields) {
        columns = raw.fields.map((field: any) => field.name);
      } else if (raw.rows.length > 0) {
        columns = Object.keys(raw.rows[0]);
      }
    } else if (raw && raw.recordset && Array.isArray(raw.recordset)) {
      // MSSQL format
      rows = raw.recordset;
      if (raw.recordset.length > 0) {
        columns = Object.keys(raw.recordset[0]);
      }
    } else if (raw && Array.isArray(raw)) {
      // MySQL format
      rows = raw;
      if (raw.length > 0) {
        columns = Object.keys(raw[0]);
      }
    }

    return {
      executionTime,
      rowCount: rows.length,
      columns,
      rows,
      raw,
      success: true
    };
  } catch (error) {
    logger.error(`Error creating query result:`, error);
    return {
      executionTime,
      rowCount: 0,
      columns: [],
      rows: [],
      raw,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}; 