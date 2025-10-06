import React, { useEffect, useMemo, useState, useRef } from 'react';
import { classifyViaLLM, optimizeCategoriesViaLLM, LLMConfig, DEFAULT_CONFIGS } from './api';
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

export default function App() {
  const [llmConfig, setLlmConfig] = useState<LLMConfig>({
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    model: 'local-model',
    maxTokens: 4096,
    systemMessage: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1).',
  });
  const [directory, setDirectory] = useState<string | null>(null);
  const [includeSubdirectories, setIncludeSubdirectories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [statusExpanded, setStatusExpanded] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  
  // Column widths (in pixels)
  const [columnWidths, setColumnWidths] = useState({
    apply: 60,
    source: 300,
    category: 200,
    filename: 200,
    ext: 60,
    proposedTo: 300,
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
      
      // Show current progress and send to LM Studio for optimization
      await finalizeScan();
    }
  };

  const finalizeScan = async () => {
    const previews = scanControlRef.current.processedFiles;
    
    const outRows: Row[] = previews.map((p: any) => {
      const { name, ext } = splitPath(p.src);
      const category = p.llm ? sanitizeDirpath(p.llm.category_path || 'uncategorized') : 'uncategorized';
      const newName = p.llm ? sanitizeFilename(p.llm.suggested_filename || name) : name;

      return {
        src: p.src,
        readable: !!p.readable,
        reason: p.reason,
        category: category,
        name: newName,
        ext: ext,
        enabled: !!p.dst,
      };
    });
    
    setRows(outRows);
    setProgress({ current: scanControlRef.current.currentFileIndex, total: scanControlRef.current.allFiles.length });
    setBusy(false);
    setScanState('completed');
    
    // Automatically run optimization after scan completion/stop
    if (outRows.length > 0) {
      setEvents((prev: string[]) => ['Sending current results to LLM for optimization...', ...prev]);
      await optimizeCategories();
    }
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
          result = { category_path: 'uncategorized', suggested_filename: f.replace(/\.[^/.]+$/, ''), confidence: 0, raw: { error: e?.message || String(e) } };
        }
        const ext = '.' + (f.split('.').pop() || '');
        const safe = sanitizeFilename(result.suggested_filename || f.replace(/\.[^/.]+$/, ''));
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
      } else {
        setEvents((prev: string[]) => [`Skipping ${f}: ${reason}`, ...prev]);
        processedFiles.push(info);
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
        <aside className="app-sidebar">
          {/* LLM Configuration */}
          <LLMConfigPanel
            config={llmConfig}
            onChange={setLlmConfig}
            onTest={testLLMConnection}
            disabled={busy}
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
                    <col style={{ width: `${columnWidths.proposedTo}px` }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        Apply
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'apply')} />
                      </th>
                      <th>
                        Source
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'source')} />
                      </th>
                      <th>
                        Category
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'category')} />
                      </th>
                      <th>
                        Filename
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'filename')} />
                      </th>
                      <th>
                        Ext
                        <div className="resize-handle" onMouseDown={(e) => handleResizeStart(e, 'ext')} />
                      </th>
                      <th>
                        Proposed To
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: Row, i: number) => (
                      <tr key={i}>
                        <td><input aria-label={`Select ${r.src}`} type="checkbox" checked={!!r.enabled} onChange={e => updateRow(i, { enabled: e.target.checked })} /></td>
                        <td><code>{getRelativePath(r.src)}</code>{!r.enabled && <div className="muted">{r.reason || ''}</div>}</td>
                        <td><input aria-label={`Category for ${r.src}`} type="text" value={r.category} placeholder="Category" onChange={e => updateRow(i, { category: e.target.value })} /></td>
                        <td><input aria-label={`Name for ${r.src}`} type="text" value={r.name} placeholder="New filename" onChange={e => updateRow(i, { name: e.target.value })} /></td>
                        <td>{r.ext}</td>
                        <td>{getRelativeToPath(r)}</td>
                      </tr>
                    ))}
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
