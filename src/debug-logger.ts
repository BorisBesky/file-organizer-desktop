/**
 * Debug logging utility for troubleshooting LLM API issues
 */

import { invoke } from '@tauri-apps/api/tauri';

export interface DebugLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  data?: any;
}

class DebugLogger {
  private logs: DebugLog[] = [];
  private maxLogs = 1000; // Keep last 1000 logs
  private enabled = true;

  log(level: DebugLog['level'], category: string, message: string, data?: any) {
    if (!this.enabled) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data: data ? this.sanitizeData(data) : undefined,
    };

    this.logs.push(log);
    
    // Keep only recent logs
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Also log to console
    const consoleMsg = `[${log.timestamp}] [${level.toUpperCase()}] [${category}] ${message}`;
    switch (level) {
      case 'error':
        console.error(consoleMsg, data);
        break;
      case 'warn':
        console.warn(consoleMsg, data);
        break;
      case 'debug':
        console.debug(consoleMsg, data);
        break;
      default:
        console.log(consoleMsg, data);
    }
  }

  private sanitizeData(data: any): any {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sanitized: any = Array.isArray(data) ? [] : {};
    
    for (const key in data) {
      const value = data[key];
      
      // Sanitize sensitive headers
      if (key.toLowerCase() === 'authorization' && typeof value === 'string') {
        if (value.length > 20) {
          sanitized[key] = value.substring(0, 20) + '...' + value.substring(value.length - 4);
        } else {
          sanitized[key] = '***';
        }
      } else if (key.toLowerCase().includes('key') && typeof value === 'string') {
        if (value.length > 20) {
          sanitized[key] = value.substring(0, 10) + '...' + value.substring(value.length - 4);
        } else {
          sanitized[key] = '***';
        }
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  info(category: string, message: string, data?: any) {
    this.log('info', category, message, data);
  }

  warn(category: string, message: string, data?: any) {
    this.log('warn', category, message, data);
  }

  error(category: string, message: string, data?: any) {
    this.log('error', category, message, data);
  }

  debug(category: string, message: string, data?: any) {
    this.log('debug', category, message, data);
  }

  getLogs(): DebugLog[] {
    return [...this.logs];
  }

  getLogsAsText(): string {
    return this.logs.map(log => {
      let line = `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}`;
      if (log.data) {
        line += '\n  Data: ' + JSON.stringify(log.data, null, 2).split('\n').join('\n  ');
      }
      return line;
    }).join('\n');
  }

  clear() {
    this.logs = [];
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  async saveLogs(filename = 'debug-logs.txt'): Promise<string> {
    const text = this.getLogsAsText();
    
    try {
      const savedPath = await invoke<string>('save_diagnostic_logs', {
        content: text,
        filename: filename
      });
      return savedPath;
    } catch (error) {
      console.error('Failed to save logs:', error);
      throw error;
    }
  }

  // Deprecated: Use saveLogs() instead
  downloadLogs(filename = 'debug-logs.txt') {
    console.warn('downloadLogs is deprecated. Use saveLogs() instead.');
    this.saveLogs(filename).catch(console.error);
  }
}

// Export singleton instance
export const debugLogger = new DebugLogger();
