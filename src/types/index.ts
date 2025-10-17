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
  model_path?: string;
  log_level: string;
  // Environment variables for the server
  env_vars: Record<string, string>;
}

// File analysis types
export interface DuplicateFileGroup {
  hash: string;
  size: number;
  files: string[];
}

export interface UnusedFileInfo {
  path: string;
  size: number;
  last_accessed: string | null;
  last_modified: string | null;
  days_since_access: number | null;
}

export interface UnreferencedFileInfo {
  path: string;
  size: number;
  extension: string;
}

export interface FileAnalysisResult {
  duplicates: DuplicateFileGroup[];
  unused: UnusedFileInfo[];
  unreferenced: UnreferencedFileInfo[];
}

export type FileAnalysisTab = 'duplicates' | 'unused' | 'unreferenced';