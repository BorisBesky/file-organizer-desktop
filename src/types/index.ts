// This file defines TypeScript types and interfaces used in the application, ensuring type safety and better development experience.

export type Row = {
  src: string;
  readable: boolean;
  reason?: string;
  category: string;
  name: string;
  ext: string;
  enabled: boolean;
  dst?: {
    dir: string;
    name: string;
    ext: string;
  };
};

export interface ClassifyResult {
  category_path: string;
  suggested_filename: string;
  confidence: number;
  raw?: any;
}

export type ScanState = 'idle' | 'scanning' | 'stopped' | 'completed' | 'organizing';

export interface ScanControl {
  state: ScanState;
  shouldStop: boolean;
  currentFileIndex: number;
  processedFiles: any[];
}

// Managed LLM Server types
export type LLMServerStatus = 'not_downloaded' | 'downloaded' | 'running' | 'stopped' | 'error';

export interface ManagedLLMServerInfo {
  status: LLMServerStatus;
  version?: string;
  path?: string;
  port?: number;
  error?: string;
}

export interface ManagedLLMConfig {
  port: number;
  host: string;
  model?: string;
  model_filename?: string;
  model_path?: string;
  log_level: string;
  env_vars: Record<string, string>;
  mmproj_repo_id?: string;
  mmproj_filename?: string;
  chat_format?: string;
}

// Saved processed files state for persistence
export interface SavedProcessedState {
  directory?: string; // For backwards compatibility
  directories?: string[]; // New field for multiple directories
  includeSubdirectories: boolean;
  rows: Row[];
  processedFiles: any[];
  allFiles: string[];
  currentFileIndex: number;
  used: string[];
  scanState: ScanState;
  progress: {
    current: number;
    total: number;
  };
  timestamp: number;
}