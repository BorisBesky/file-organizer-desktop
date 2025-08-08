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