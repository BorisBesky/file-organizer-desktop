import React, { useEffect, useMemo, useState, useRef } from 'react';
import { classifyViaLLM, optimizeCategoriesViaLLM, LLMConfig, DEFAULT_CONFIGS, openFile } from './api';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { ScanState } from './types';
import { LLMConfigPanel, HelpDialog, AboutDialog } from './components';

function sanitizeFilename(name: string) {
  let out = name.trim().replace(/[\n\r]/g, ' ');
  const bad = '<>:"/\\|?*';
  for (const ch of bad) out = out.split(ch).join('-');
  out = out.replace(/\s+/g, ' ').split(' ').filter(Boolean).join('-');
  return out.slice(0, 200);
}

function sanitizeDirpath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  return parts.map(sanitizeFilename).join('/') || 'uncategorized';
}

function splitPath(p: string) {
  const i = p.lastIndexOf('/');
  const dir = i >= 0 ? p.slice(0, i) : '';
  const file = i >= 0 ? p.slice(i + 1) : p;
  const j = file.lastIndexOf('.');
  const name = j >= 0 ? file.slice(0, j) : file;
  const ext = j >= 0 ? file.slice(j) : '';
  return { dir, name, ext };
}

type Row = { src: string; readable: boolean; reason?: string; category: string; name: string; ext: string; enabled: boolean; dst?: any };

type SortField = 'source' | 'category' | 'filename' | 'extension';
type SortDirection = 'asc' | 'desc';

export default function App() {
  // Load LLM config from localStorage or use defaults
  const loadLlmConfig = (): LLMConfig => {
    try {
      const saved = localStorage.getItem('llmConfig');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed;
      }
    } catch (error) {
      console.error('Failed to load LLM config from localStorage:', error);
    }
    // Return default config if no saved config exists
    return {
      provider: 'lmstudio',
      baseUrl: 'http://localhost:1234',
      model: 'local-model',
      maxTokens: 4096,
      maxTextLength: 4096,
      systemMessage: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).',
    };
  };

  // Load saved configs per provider
  const loadProviderConfigs = (): Record<string, LLMConfig> => {
    try {
      const saved = localStorage.getItem('llmProviderConfigs');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('Failed to load provider configs from localStorage:', error);
    }
    return {};
  };

  const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLlmConfig());
  const [providerConfigs, setProviderConfigs] = useState<Record<string, LLMConfig>>(loadProviderConfigs());
  const [directory, setDirectory] = useState<string | null>(null);
  const [includeSubdirectories, setIncludeSubdirectories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [statusExpanded, setStatusExpanded] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  
  // Sorting state
  const [sortBy, setSortBy] = useState<SortField>('source');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  
  // Sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const resizingSidebar = useRef(false);
  
  // Column widths (in pixels)
  const [columnWidths, setColumnWidths] = useState({
    apply: 60,
    source: 300,
    category: 200,
    filename: 200,
    ext: 60,
  });
  
  const resizingColumn = useRef<string | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);
  
  // Handle column resize
  const handleResizeStart = (e: React.MouseEvent, columnKey: string) => {
    e.preventDefault();
    resizingColumn.current = columnKey;
    startX.current = e.clientX;
    startWidth.current = columnWidths[columnKey as keyof typeof columnWidths];
    
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  };
  
  const handleResizeMove = (e: MouseEvent) => {
    if (!resizingColumn.current) return;
    
    const diff = e.clientX - startX.current;
    const newWidth = Math.max(50, startWidth.current + diff);
    
    setColumnWidths(prev => ({
      ...prev,
      [resizingColumn.current!]: newWidth,
    }));
  };
  
  const handleResizeEnd = () => {
    resizingColumn.current = null;
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  };
  
  // Handle sidebar resize
  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingSidebar.current = true;
    document.addEventListener('mousemove', handleSidebarResizeMove);
    document.addEventListener('mouseup', handleSidebarResizeEnd);
  };
  
  const handleSidebarResizeMove = (e: MouseEvent) => {
    if (!resizingSidebar.current) return;
    const newWidth = Math.max(250, Math.min(600, e.clientX));
    setSidebarWidth(newWidth);
  };
  
  const handleSidebarResizeEnd = () => {
    resizingSidebar.current = false;
    document.removeEventListener('mousemove', handleSidebarResizeMove);
    document.removeEventListener('mouseup', handleSidebarResizeEnd);
  };
  
  // Scan control state
  const [scanState, setScanState] = useState<ScanState>('idle');
  const scanControlRef = useRef({
    shouldPause: false,
    shouldStop: false,
    currentFileIndex: 0,
    processedFiles: [] as any[],
    allFiles: [] as string[],
    used: new Set<string>(),
  });

  // Save LLM config to localStorage whenever it changes
  useEffect(() => {
    try {
      // Save current config
      localStorage.setItem('llmConfig', JSON.stringify(llmConfig));
      
      // Save per-provider config
      const newProviderConfigs = {
        ...providerConfigs,
        [llmConfig.provider]: llmConfig
      };
      localStorage.setItem('llmProviderConfigs', JSON.stringify(newProviderConfigs));
      setProviderConfigs(newProviderConfigs);
    } catch (error) {
      console.error('Failed to save LLM config to localStorage:', error);
    }
  }, [llmConfig, providerConfigs]);

  // Function to load a provider's saved config
  const loadProviderConfig = (provider: string) => {
    const savedConfig = providerConfigs[provider];
    if (savedConfig) {
      setLlmConfig(savedConfig);
    }
  };

  useEffect(() => {
    const unlisten = listen<string>('directory-selected', (event) => {
      setDirectory(event.payload);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlistenHelp = listen('show-help', () => {
      setHelpOpen(true);
    });
    const unlistenAbout = listen('show-about', () => {
      setAboutOpen(true);
    });
    return () => {
      unlistenHelp.then(f => f());
      unlistenAbout.then(f => f());
    };
  }, []);

  const pickDirectory = () => {
    invoke('pick_directory');
  };

  const pauseScan = () => {
    if (scanState === 'scanning') {
      scanControlRef.current.shouldPause = true;
      setScanState('paused');
      setEvents((prev: string[]) => ['Scan paused by user', ...prev]);
    }
  };

  const resumeScan = () => {
    if (scanState === 'paused') {
      scanControlRef.current.shouldPause = false;
      setScanState('scanning');
      setEvents((prev: string[]) => ['Scan resumed', ...prev]);
      // Continue processing from where we left off
      processRemainingFiles();
    }
  };

  const stopScan = async () => {
    if (scanState === 'scanning' || scanState === 'paused') {
      scanControlRef.current.shouldStop = true;
      setScanState('stopped');
      setEvents((prev: string[]) => ['Scan stopped by user', ...prev]);
      
      // Show current progress
      await finalizeScan();
    }
  };

  const convertToRow = (p: any): Row => {
    const { name, ext } = splitPath(p.src);
    const category = p.llm ? sanitizeDirpath(p.llm.category_path || 'uncategorized') : 'uncategorized';
    // Use original filename if suggested filename is empty, "unknown", not provided, or uncategorized
    const suggestedName = p.llm?.suggested_filename;
    const shouldUseOriginal = !suggestedName || 
                             suggestedName.toLowerCase() === 'unknown' ||
                             suggestedName.toLowerCase().includes('undefined') ||
                             category.toLowerCase().includes('uncategorized');

    
    const newName = shouldUseOriginal ? name : sanitizeFilename(suggestedName);

    return {
      src: p.src,
      readable: !!p.readable,
      reason: p.reason,
      category: category,
      name: newName,
      ext: ext,
      enabled: !!p.dst,
    };
  };

  const finalizeScan = async () => {
    setProgress({ current: scanControlRef.current.currentFileIndex, total: scanControlRef.current.allFiles.length });
    setBusy(false);
    setScanState('completed');
  };

  const processRemainingFiles = async () => {
    const { allFiles, currentFileIndex, processedFiles, used } = scanControlRef.current;
    
    for (let i = currentFileIndex; i < allFiles.length; i++) {
      // Check for pause or stop signals
      if (scanControlRef.current.shouldPause) {
        scanControlRef.current.currentFileIndex = i;
        return;
      }
      
      if (scanControlRef.current.shouldStop) {
        scanControlRef.current.currentFileIndex = i;
        await finalizeScan();
        return;
      }
      
      const f = allFiles[i];
      scanControlRef.current.currentFileIndex = i + 1;
      setProgress({ current: i + 1, total: allFiles.length });
      
      let text = '';
      let readable = false;
      let reason = 'unsupported';

      try {
        text = await invoke('read_file_content', { path: f });
        readable = true;
        reason = 'text';
      } catch (e) {
        // ignore
      }

      setEvents((prev: string[]) => [`Reading ${f} (${reason})`, ...prev]);
      const info: any = { src: f, readable, reason };
      
      if (readable) {
        setEvents((prev: string[]) => [`Classifying ${f}`, ...prev]);
        let result;
        try {
          result = await classifyViaLLM({ config: llmConfig, text, originalName: splitPath(f).name, categoriesHint });
        } catch (e: any) {
          result = { category_path: 'uncategorized', suggested_filename: splitPath(f).name, confidence: 0, raw: { error: e?.message || String(e) } };
        }
        const ext = '.' + (f.split('.').pop() || '');
        const safe = sanitizeFilename(result.suggested_filename || splitPath(f).name);
        const dir = sanitizeDirpath(result.category_path || 'uncategorized');
        const dst = `${directory}/${dir}/${safe}${ext}`;
        let finalDst = dst;
        let j = 1;
        while (used.has(finalDst)) { finalDst = `${directory}/${dir}/${safe}-${j}${ext}`; j += 1; }
        used.add(finalDst);
        info.llm = result;
        info.dst = finalDst;
        processedFiles.push(info);
        setEvents((prev: string[]) => [`Classified ${f} -> ${dir} => ${finalDst}`, ...prev]);
        
        // Add row to table immediately
        const newRow = convertToRow(info);
        setRows((prev: Row[]) => [...prev, newRow]);
      } else {
        setEvents((prev: string[]) => [`Skipping ${f}: ${reason}`, ...prev]);
        processedFiles.push(info);
        
        // Add skipped file to table immediately
        const newRow = convertToRow(info);
        setRows((prev: Row[]) => [...prev, newRow]);
      }
    }
    
    // If we reach here, scan completed normally
    setScanState('completed');
    await finalizeScan();
  };

  const categoriesHint = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r: Row) => { if (r.category) set.add(r.category); });
    return Array.from(set);
  }, [rows]);


  const scan = async () => {
    if (!directory) return alert('Pick a directory first');
    
    // Reset scan control state
    scanControlRef.current = {
      shouldPause: false,
      shouldStop: false,
      currentFileIndex: 0,
      processedFiles: [],
      allFiles: [],
      used: new Set<string>(),
    };
    
    setBusy(true);
    setScanState('scanning');
    setEvents([]);
    setRows([]);
    setProgress({ current: 0, total: 0 });

    try {
      const files: string[] = await invoke('read_directory', { path: directory, includeSubdirectories: includeSubdirectories });
      const processableFiles = files.filter(f => !splitPath(f).name.startsWith('.'));
      
      scanControlRef.current.allFiles = processableFiles;
      setProgress({ current: 0, total: processableFiles.length });
      
      setEvents((prev: string[]) => [`Found ${processableFiles.length} files to process`, ...prev]);
      
      // Start processing files
      await processRemainingFiles();
    } catch (error: any) {
      setEvents((prev: string[]) => [`Error reading directory: ${error.message || String(error)}`, ...prev]);
      setBusy(false);
      setScanState('idle');
    }
  };

  const optimizeCategories = async () => {
    if (!rows.length) return;
    
    setBusy(true);
    setEvents((prev: string[]) => ['Analyzing directory structure for optimizations...', ...prev]);
    
    // Build directory tree from current rows
    const directoryTree: { [category: string]: string[] } = {};
    rows.forEach(row => {
      if (!directoryTree[row.category]) {
        directoryTree[row.category] = [];
      }
      directoryTree[row.category].push(`${row.name}${row.ext}`);
    });
    
    try {
      const result = await optimizeCategoriesViaLLM({
        config: llmConfig,
        directoryTree,
      });
      
      if (result.optimizations && result.optimizations.length > 0) {
        setEvents((prev: string[]) => [`Found ${result.optimizations.length} optimization suggestions:`, ...prev]);
        
        // Apply optimizations to rows
        const updatedRows = rows.map(row => {
          const optimization = result.optimizations.find((opt: { from: string; to: string; reason: string }) => opt.from === row.category);
          if (optimization) {
            setEvents((prev: string[]) => [`  ${optimization.from} → ${optimization.to}: ${optimization.reason}`, ...prev]);
            return { ...row, category: optimization.to };
          }
          return row;
        });
        
        setRows(updatedRows);
        setEvents((prev: string[]) => ['Applied category optimizations successfully.', ...prev]);
      } else {
        setEvents((prev: string[]) => ['No optimizations suggested - directory structure looks good!', ...prev]);
      }
    } catch (e: any) {
      setEvents((prev: string[]) => [`Failed to optimize categories: ${e?.message || String(e)}`, ...prev]);
    }
    
    setBusy(false);
  };

  const applyMoves = async () => {
    setBusy(true);
    setScanState('organizing');
    const selected = rows.filter((r: Row) => r.enabled);
    const totalToMove = selected.length;
    const totalAnalyzed = rows.length;
    let movedCount = 0;
    let failedCount = 0;
    
    // Update progress to show organizing phase
    setProgress({ current: 0, total: totalToMove });
    
    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      const to = toPath(row);
      try {
        await invoke('move_file', { from: row.src, to });
        movedCount++;
        setProgress({ current: movedCount, total: totalToMove });
        setEvents((prev: string[]) => [`Moved ${row.src} to ${to}`, ...prev]);
      } catch (e: any) {
        failedCount++;
        setEvents((prev: string[]) => [`Failed to move ${row.src}: ${e}`, ...prev]);
      }
    }
    
    setRows([]);
    const summary = `Done. Analyzed ${totalAnalyzed} files, organized ${movedCount} files${failedCount > 0 ? `, ${failedCount} failed` : ''}.`;
    setEvents((prev: string[]) => [summary, ...prev]);
    setScanState('idle');
    setBusy(false);
  };

  const updateRow = (i: number, patch: Partial<Row>) => {
    setRows((prev: Row[]) => prev.map((r: Row, idx: number) => idx === i ? { ...r, ...patch } : r));
  };

  const resetScan = () => {
    setScanState('idle');
    setRows([]);
    setEvents([]);
    setProgress({ current: 0, total: 0 });
    setBusy(false);
    scanControlRef.current = {
      shouldPause: false,
      shouldStop: false,
      currentFileIndex: 0,
      processedFiles: [],
      allFiles: [],
      used: new Set<string>(),
    };
  };

  const toPath = (r: Row) => `${directory}/${r.category}/${r.name}${r.ext}`;
  
  // Get relative path from the selected directory
  const getRelativePath = (fullPath: string) => {
    if (!directory) return fullPath;
    const dirWithSlash = directory.endsWith('/') ? directory : directory + '/';
    return fullPath.startsWith(dirWithSlash) ? fullPath.slice(dirWithSlash.length) : fullPath;
  };
  
  const getRelativeToPath = (r: Row) => `${r.category}/${r.name}${r.ext}`;

  // Sorting functions
  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortDirection('asc');
    }
  };

  // Handle file opening
  const handleOpenFile = async (filePath: string) => {
    try {
      await openFile(filePath);
    } catch (error: any) {
      setEvents((prev: string[]) => [`Failed to open ${filePath}: ${error.message}`, ...prev]);
    }
  };

  const getSortedRows = (): Row[] => {
    return [...rows].sort((a, b) => {
      let aValue: string;
      let bValue: string;

      switch (sortBy) {
        case 'source':
          aValue = getRelativePath(a.src).toLowerCase();
          bValue = getRelativePath(b.src).toLowerCase();
          break;
        case 'category':
          aValue = a.category.toLowerCase();
          bValue = b.category.toLowerCase();
          break;
        case 'filename':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'extension':
          aValue = a.ext.toLowerCase();
          bValue = b.ext.toLowerCase();
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const getSortIcon = (field: SortField) => {
    if (sortBy !== field) return '↕';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  // Bulk select functions
  const handleSelectAll = (checked: boolean) => {
    setRows((prev: Row[]) => prev.map((r: Row) => ({ ...r, enabled: checked })));
  };

  const getSelectAllState = () => {
    if (rows.length === 0) return { checked: false, indeterminate: false };
    const enabledCount = rows.filter(r => r.enabled).length;
    return {
      checked: enabledCount === rows.length,
      indeterminate: enabledCount > 0 && enabledCount < rows.length
    };
  };

  const testLLMConnection = async () => {
    // Simple test by sending a minimal classification request
    try {
      const testResult = await classifyViaLLM({
        config: llmConfig,
        text: 'Test document for connection verification',
        originalName: 'test.txt',
        categoriesHint: [],
      });
      if (!testResult || !testResult.category_path) {
        throw new Error('Invalid response from LLM provider');
      }
    } catch (error: any) {
      // Provide more detailed error message
      const message = error.message || String(error);
      throw new Error(`Connection test failed: ${message}`);
    }
  };

  return (
    <div className="app-layout">
      {/* Progress/Status Header */}
      <div className="app-header">
        {(busy || scanState !== 'idle') && progress.total > 0 && (
          <div className="header-progress">
            <div className="progress-label">
              Progress - {scanState.charAt(0).toUpperCase() + scanState.slice(1)}
            </div>
            <div className="progress-container">
              <div 
                className="progress-bar"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <div className="progress-text">
              {scanState === 'organizing' 
                ? `${progress.current} out of ${progress.total} files moved`
                : `${progress.current} / ${progress.total} files`
              } ({Math.round((progress.current / progress.total) * 100)}%)
              {scanState === 'stopped' && ` - Stopped`}
              {scanState === 'paused' && ` - Paused`}
            </div>
          </div>
        )}

        {!!events.length && (
          <div className="header-status">
            <button
              type="button"
              className="status-toggle"
              onClick={() => setStatusExpanded(!statusExpanded)}
            >
              <span className="toggle-icon">{statusExpanded ? '▼' : '▶'}</span>
              <span>Status Log</span>
            </button>
            {statusExpanded && (
              <textarea
                readOnly
                rows={4}
                value={events.join('\n')}
                className="status-textarea"
                aria-label="Status events log"
                title="Status events log"
              />
            )}
          </div>
        )}
      </div>

      {/* Main Layout: Sidebar + Content */}
      <div className="app-main">
        {/* Left Sidebar */}
        <aside className="app-sidebar" style={{ width: `${sidebarWidth}px` }}>
          {/* LLM Configuration */}
          <LLMConfigPanel
            config={llmConfig}
            onChange={setLlmConfig}
            onTest={testLLMConnection}
            disabled={busy}
            providerConfigs={providerConfigs}
            onLoadProviderConfig={loadProviderConfig}
          />

          {/* Directory Picker Section */}
          <div className="sidebar-section">
            <h3>Directory</h3>
            <button onClick={pickDirectory} disabled={busy} className="w-full">
              Pick Directory
            </button>
            {directory && (
              <div className="directory-display">{directory}</div>
            )}
            <label className="mt8">
              <input 
                type="checkbox" 
                checked={includeSubdirectories} 
                onChange={e => setIncludeSubdirectories(e.target.checked)}
                disabled={busy || scanState === 'scanning' || scanState === 'paused'}
              />
              Include subdirectories
            </label>
          </div>

          {/* Scan Controls Section */}
          <div className="sidebar-section">
            <h3>Scan</h3>
            <div className="button-column">
              <button 
                onClick={scan} 
                disabled={busy || !directory || scanState === 'scanning' || scanState === 'paused'}
                className="w-full"
              >
                {scanState === 'scanning' ? 'Scanning...' : scanState === 'paused' ? 'Paused' : 'Start Scan'}
              </button>
              
              {scanState === 'scanning' && (
                <>
                  <button className="warning w-full" onClick={pauseScan} disabled={!busy}>Pause</button>
                  <button className="danger w-full" onClick={stopScan} disabled={!busy}>Stop</button>
                </>
              )}
              
              {scanState === 'paused' && (
                <>
                  <button className="w-full" onClick={resumeScan}>Resume</button>
                  <button className="danger w-full" onClick={stopScan}>Stop</button>
                </>
              )}
              
              {scanState === 'stopped' && (
                <button className="w-full" onClick={resumeScan}>Continue Scan</button>
              )}
              
              {scanState === 'completed' && (
                <button className="secondary w-full" onClick={resetScan}>New Scan</button>
              )}
            </div>
          </div>
        </aside>
        
        {/* Sidebar Resize Handle */}
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarResizeStart} />

        {/* Main Content Area */}
        <main className="app-content">
          {!!rows.length ? (
            <div className="content-section">
              <div className="content-header">
                <h2>Review & Edit Proposals</h2>
                <div className="button-row">
                  <button className="secondary" onClick={optimizeCategories} disabled={busy}>
                    {busy ? 'Optimizing...' : 'Optimize Categories'}
                  </button>
                  <button onClick={applyMoves} disabled={busy}>Approve Selected</button>
                </div>
              </div>
              <div className="scroll-x">
                <table className="resizable-table">
                  <colgroup>
                    <col style={{ width: `${columnWidths.apply}px` }} />
                    <col style={{ width: `${columnWidths.source}px` }} />
                    <col style={{ width: `${columnWidths.category}px` }} />
                    <col style={{ width: `${columnWidths.filename}px` }} />
                    <col style={{ width: `${columnWidths.ext}px` }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <input 
                          type="checkbox" 
                          checked={getSelectAllState().checked}
                          ref={(input) => {
                            if (input) input.indeterminate = getSelectAllState().indeterminate;
                          }}
                          onChange={(e) => handleSelectAll(e.target.checked)}
                          aria-label="Select all files"
                          title="Select/deselect all files"
                        />
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'apply')} />
                      </th>
                      <th 
                        className="sortable-header" 
                        onClick={() => handleSort('source')}
                        style={{ cursor: 'pointer' }}
                        title="Click to sort by source path"
                      >
                        Source {getSortIcon('source')}
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'source')} />
                      </th>
                      <th 
                        className="sortable-header" 
                        onClick={() => handleSort('category')}
                        style={{ cursor: 'pointer' }}
                        title="Click to sort by category"
                      >
                        Category {getSortIcon('category')}
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'category')} />
                      </th>
                      <th 
                        className="sortable-header" 
                        onClick={() => handleSort('filename')}
                        style={{ cursor: 'pointer' }}
                        title="Click to sort by filename"
                      >
                        Filename {getSortIcon('filename')}
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'filename')} />
                      </th>
                      <th 
                        className="sortable-header" 
                        onClick={() => handleSort('extension')}
                        style={{ cursor: 'pointer' }}
                        title="Click to sort by extension"
                      >
                        Ext {getSortIcon('extension')}
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'ext')} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {getSortedRows().map((r: Row, i: number) => {
                      // Find the original index in the unsorted array for updates
                      const originalIndex = rows.findIndex(row => row.src === r.src);
                      return (
                        <tr key={originalIndex}>
                          <td><input aria-label={`Select ${r.src}`} type="checkbox" checked={!!r.enabled} onChange={e => updateRow(originalIndex, { enabled: e.target.checked })} /></td>
                          <td>
                            <code 
                              className="clickable-file-path" 
                              onClick={() => handleOpenFile(r.src)}
                              title="Click to open file"
                            >
                              {getRelativePath(r.src)}
                            </code>
                          </td>
                          <td><input aria-label={`Category for ${r.src}`} type="text" value={r.category} placeholder="Category" onChange={e => updateRow(originalIndex, { category: e.target.value })} /></td>
                          <td><input aria-label={`Name for ${r.src}`} type="text" value={r.name} placeholder="New filename" onChange={e => updateRow(originalIndex, { name: e.target.value })} /></td>
                          <td>{r.ext}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="content-empty">
              <p>Configure a LLM provider, select a directory and start a scan to organize your files.</p>
            </div>
          )}
        </main>
      </div>

      {/* Help and About Dialogs */}
      <HelpDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
      <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
}
