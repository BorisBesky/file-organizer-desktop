import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { 
  analyzeDirectoryFiles, 
  findDuplicateFiles, 
  findUnusedFiles, 
  findUnreferencedFiles 
} from '../api';
import { 
  FileAnalysisResult, 
  DuplicateFileGroup, 
  UnusedFileInfo, 
  UnreferencedFileInfo,
  FileAnalysisTab 
} from '../types';

interface FileAnalysisPanelProps {
  directory: string | null;
  includeSubdirectories: boolean;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatRelativePath = (path: string, directory: string | null): string => {
  if (!directory) return path;
  const dirWithSlash = directory.endsWith('/') ? directory : directory + '/';
  return path.startsWith(dirWithSlash) ? path.slice(dirWithSlash.length) : path;
};

export default function FileAnalysisPanel({ directory, includeSubdirectories }: FileAnalysisPanelProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [activeTab, setActiveTab] = useState<FileAnalysisTab>('duplicates');
  const [analysisResult, setAnalysisResult] = useState<FileAnalysisResult | null>(null);
  const [unusedDaysThreshold, setUnusedDaysThreshold] = useState(90);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    if (!directory) {
      setError('Please select a directory first');
      return;
    }

    setAnalyzing(true);
    setError(null);
    setSelectedFiles(new Set());

    try {
      const result = await analyzeDirectoryFiles(directory, includeSubdirectories, unusedDaysThreshold);
      setAnalysisResult(result);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const toggleFileSelection = (path: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    setSelectedFiles(newSelected);
  };

  const selectAllInTab = () => {
    if (!analysisResult) return;
    
    const newSelected = new Set(selectedFiles);
    const files = activeTab === 'duplicates' 
      ? analysisResult.duplicates.flatMap(g => g.files.slice(1)) // Keep first file of each duplicate group
      : activeTab === 'unused'
      ? analysisResult.unused.map(f => f.path)
      : analysisResult.unreferenced.map(f => f.path);
    
    files.forEach(f => newSelected.add(f));
    setSelectedFiles(newSelected);
  };

  const deselectAll = () => {
    setSelectedFiles(new Set());
  };

  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    
    const confirmMsg = `Are you sure you want to delete ${selectedFiles.size} file(s)? This action cannot be undone.`;
    if (!confirm(confirmMsg)) return;

    let successCount = 0;
    let errorCount = 0;

    for (const filePath of selectedFiles) {
      try {
        await invoke('move_file', { from: filePath, to: filePath + '.deleted' });
        // Actually delete by moving to trash would be better, but for now we'll just mark as deleted
        successCount++;
      } catch (err) {
        console.error(`Failed to delete ${filePath}:`, err);
        errorCount++;
      }
    }

    alert(`Deleted ${successCount} file(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
    
    // Refresh the analysis
    if (successCount > 0) {
      setSelectedFiles(new Set());
      handleAnalyze();
    }
  };

  const handleOpenFile = async (path: string) => {
    try {
      await invoke('open_file', { path });
    } catch (err: any) {
      alert(`Failed to open file: ${err.message || String(err)}`);
    }
  };

  const renderDuplicates = () => {
    if (!analysisResult?.duplicates.length) {
      return <div className="empty-state">No duplicate files found</div>;
    }

    const totalWasted = analysisResult.duplicates.reduce(
      (sum, group) => sum + group.size * (group.files.length - 1), 
      0
    );

    return (
      <div className="analysis-results">
        <div className="results-summary">
          <strong>{analysisResult.duplicates.length}</strong> duplicate groups found
          <span className="ml-2">•</span>
          <span className="ml-2">Wasted space: <strong>{formatBytes(totalWasted)}</strong></span>
        </div>
        {analysisResult.duplicates.map((group, idx) => (
          <div key={idx} className="duplicate-group">
            <div className="duplicate-header">
              <span className="duplicate-info">
                {group.files.length} copies • {formatBytes(group.size)} each
              </span>
            </div>
            <ul className="file-list">
              {group.files.map((file, fileIdx) => (
                <li key={fileIdx} className="file-item">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(file)}
                    onChange={() => toggleFileSelection(file)}
                    disabled={fileIdx === 0} // Don't allow deleting the first (keep one copy)
                  />
                  <span 
                    className="file-path clickable"
                    onClick={() => handleOpenFile(file)}
                    title="Click to open file"
                  >
                    {formatRelativePath(file, directory)}
                  </span>
                  {fileIdx === 0 && <span className="badge">keep</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  };

  const renderUnused = () => {
    if (!analysisResult?.unused.length) {
      return <div className="empty-state">No unused files found (older than {unusedDaysThreshold} days)</div>;
    }

    const totalSize = analysisResult.unused.reduce((sum, file) => sum + file.size, 0);

    return (
      <div className="analysis-results">
        <div className="results-summary">
          <strong>{analysisResult.unused.length}</strong> unused files found
          <span className="ml-2">•</span>
          <span className="ml-2">Total size: <strong>{formatBytes(totalSize)}</strong></span>
        </div>
        <ul className="file-list">
          {analysisResult.unused.map((file, idx) => (
            <li key={idx} className="file-item">
              <input
                type="checkbox"
                checked={selectedFiles.has(file.path)}
                onChange={() => toggleFileSelection(file.path)}
              />
              <span 
                className="file-path clickable"
                onClick={() => handleOpenFile(file.path)}
                title="Click to open file"
              >
                {formatRelativePath(file.path, directory)}
              </span>
              <span className="file-meta">
                {formatBytes(file.size)}
                {file.days_since_access && ` • ${file.days_since_access} days since access`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderUnreferenced = () => {
    if (!analysisResult?.unreferenced.length) {
      return <div className="empty-state">No unreferenced files found</div>;
    }

    const totalSize = analysisResult.unreferenced.reduce((sum, file) => sum + file.size, 0);

    return (
      <div className="analysis-results">
        <div className="results-summary">
          <strong>{analysisResult.unreferenced.length}</strong> unreferenced files found
          <span className="ml-2">•</span>
          <span className="ml-2">Total size: <strong>{formatBytes(totalSize)}</strong></span>
        </div>
        <ul className="file-list">
          {analysisResult.unreferenced.map((file, idx) => (
            <li key={idx} className="file-item">
              <input
                type="checkbox"
                checked={selectedFiles.has(file.path)}
                onChange={() => toggleFileSelection(file.path)}
              />
              <span 
                className="file-path clickable"
                onClick={() => handleOpenFile(file.path)}
                title="Click to open file"
              >
                {formatRelativePath(file.path, directory)}
              </span>
              <span className="file-meta">
                {formatBytes(file.size)}
                {file.extension && ` • .${file.extension}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="file-analysis-panel">
      <div className="panel-header">
        <h3>File Analysis</h3>
        <div className="analysis-controls">
          <label className="control-label">
            Unused threshold (days):
            <input
              type="number"
              min="1"
              max="3650"
              value={unusedDaysThreshold}
              onChange={(e) => setUnusedDaysThreshold(parseInt(e.target.value) || 90)}
              className="threshold-input"
            />
          </label>
          <button 
            onClick={handleAnalyze} 
            disabled={analyzing || !directory}
            className="primary"
          >
            {analyzing ? 'Analyzing...' : 'Analyze Files'}
          </button>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {analysisResult && (
        <>
          <div className="tab-bar">
            <button
              className={`tab-button ${activeTab === 'duplicates' ? 'active' : ''}`}
              onClick={() => setActiveTab('duplicates')}
            >
              Duplicates ({analysisResult.duplicates.length})
            </button>
            <button
              className={`tab-button ${activeTab === 'unused' ? 'active' : ''}`}
              onClick={() => setActiveTab('unused')}
            >
              Unused ({analysisResult.unused.length})
            </button>
            <button
              className={`tab-button ${activeTab === 'unreferenced' ? 'active' : ''}`}
              onClick={() => setActiveTab('unreferenced')}
            >
              Unreferenced ({analysisResult.unreferenced.length})
            </button>
          </div>

          <div className="action-bar">
            <div className="selection-info">
              {selectedFiles.size > 0 && (
                <span>{selectedFiles.size} file(s) selected</span>
              )}
            </div>
            <div className="action-buttons">
              <button onClick={selectAllInTab} className="secondary">
                Select All
              </button>
              <button onClick={deselectAll} className="secondary" disabled={selectedFiles.size === 0}>
                Deselect All
              </button>
              <button 
                onClick={handleDeleteSelected} 
                className="danger"
                disabled={selectedFiles.size === 0}
              >
                Delete Selected ({selectedFiles.size})
              </button>
            </div>
          </div>

          <div className="tab-content">
            {activeTab === 'duplicates' && renderDuplicates()}
            {activeTab === 'unused' && renderUnused()}
            {activeTab === 'unreferenced' && renderUnreferenced()}
          </div>
        </>
      )}

      {!analysisResult && !analyzing && !error && (
        <div className="empty-state">
          Click "Analyze Files" to find duplicate, unused, and unreferenced files in the selected directory.
        </div>
      )}
    </div>
  );
}
