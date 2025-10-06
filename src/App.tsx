import React, { useEffect, useMemo, useState, useRef } from 'react';
import { classifyViaLLM, optimizeCategoriesViaLLM, LLMConfig, DEFAULT_CONFIGS } from './api';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { ScanState } from './types';
import { LLMConfigPanel } from './components';

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

  const pickDirectory = () => {
    invoke('pick_directory');
  };

  const pauseScan = () => {
    if (scanState === 'scanning') {
      scanControlRef.current.shouldPause = true;
      setScanState('paused');
      setEvents((prev: string[]) => [...prev, 'Scan paused by user']);
    }
  };

  const resumeScan = () => {
    if (scanState === 'paused') {
      scanControlRef.current.shouldPause = false;
      setScanState('scanning');
      setEvents((prev: string[]) => [...prev, 'Scan resumed']);
      // Continue processing from where we left off
      processRemainingFiles();
    }
  };

  const stopScan = async () => {
    if (scanState === 'scanning' || scanState === 'paused') {
      scanControlRef.current.shouldStop = true;
      setScanState('stopped');
      setEvents((prev: string[]) => [...prev, 'Scan stopped by user']);
      
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
      setEvents((prev: string[]) => [...prev, 'Sending current results to LM Studio for optimization...']);
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

      setEvents((prev: string[]) => [...prev, `Reading ${f} (${reason})`]);
      const info: any = { src: f, readable, reason };
      
      if (readable) {
        setEvents((prev: string[]) => [...prev, `Classifying ${f}`]);
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
        setEvents((prev: string[]) => [...prev, `Classified ${f} -> ${dir} => ${finalDst}`]);
      } else {
        setEvents((prev: string[]) => [...prev, `Skipping ${f}: ${reason}`]);
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
      
      setEvents((prev: string[]) => [...prev, `Found ${processableFiles.length} files to process`]);
      
      // Start processing files
      await processRemainingFiles();
    } catch (error: any) {
      setEvents((prev: string[]) => [...prev, `Error reading directory: ${error.message || String(error)}`]);
      setBusy(false);
      setScanState('idle');
    }
  };

  const optimizeCategories = async () => {
    if (!rows.length) return;
    
    setBusy(true);
    setEvents((prev: string[]) => [...prev, 'Analyzing directory structure for optimizations...']);
    
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
        setEvents((prev: string[]) => [...prev, `Found ${result.optimizations.length} optimization suggestions:`]);
        
        // Apply optimizations to rows
        const updatedRows = rows.map(row => {
          const optimization = result.optimizations.find((opt: { from: string; to: string; reason: string }) => opt.from === row.category);
          if (optimization) {
            setEvents((prev: string[]) => [...prev, `  ${optimization.from} → ${optimization.to}: ${optimization.reason}`]);
            return { ...row, category: optimization.to };
          }
          return row;
        });
        
        setRows(updatedRows);
        setEvents((prev: string[]) => [...prev, 'Applied category optimizations successfully.']);
      } else {
        setEvents((prev: string[]) => [...prev, 'No optimizations suggested - directory structure looks good!']);
      }
    } catch (e: any) {
      setEvents((prev: string[]) => [...prev, `Failed to optimize categories: ${e?.message || String(e)}`]);
    }
    
    setBusy(false);
  };

  const applyMoves = async () => {
    setBusy(true);
    const selected = rows.filter((r: Row) => r.enabled);
    for (const row of selected) {
      const to = toPath(row);
      try {
        await invoke('move_file', { from: row.src, to });
        setEvents((prev: string[]) => [...prev, `Moved ${row.src} to ${to}`]);
      } catch (e: any) {
        setEvents((prev: string[]) => [...prev, `Failed to move ${row.src}: ${e}`]);
      }
    }
    setRows([]);
    setEvents((prev: string[]) => [...prev, 'Done.']);
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
    <div className="container">
      <h1>AI File Organizer</h1>
      
      {/* LLM Configuration Panel */}
      <LLMConfigPanel
        config={llmConfig}
        onChange={setLlmConfig}
        onTest={testLLMConnection}
        disabled={busy}
      />
      
      <div className="row">
        <button onClick={pickDirectory} disabled={busy}>Pick Directory</button>
        <button 
          onClick={scan} 
          disabled={busy || !directory || scanState === 'scanning' || scanState === 'paused'}
        >
          {scanState === 'scanning' ? 'Scanning...' : scanState === 'paused' ? 'Paused' : 'Scan'}
        </button>
        
        {scanState === 'scanning' && (
          <>
            <button className="warning" onClick={pauseScan} disabled={!busy}>Pause</button>
            <button className="danger" onClick={stopScan} disabled={!busy}>Stop</button>
          </>
        )}
        
        {scanState === 'paused' && (
          <>
            <button onClick={resumeScan}>Resume</button>
            <button className="danger" onClick={stopScan}>Stop</button>
          </>
        )}
        
        {scanState === 'stopped' && (
          <button onClick={resumeScan}>Continue Scan</button>
        )}
        
        {scanState === 'completed' && (
          <button className="secondary" onClick={resetScan}>New Scan</button>
        )}
        
        <span>{directory ? `Selected: ${directory}` : 'No directory selected'}</span>
      </div>

      <div className="row">
        <label>
          <input 
            type="checkbox" 
            checked={includeSubdirectories} 
            onChange={e => setIncludeSubdirectories(e.target.checked)}
            disabled={busy || scanState === 'scanning' || scanState === 'paused'}
          />
          Include subdirectories
        </label>
      </div>

      {(busy || scanState !== 'idle') && progress.total > 0 && (
        <div className="mt16">
          <h3>Progress - {scanState.charAt(0).toUpperCase() + scanState.slice(1)}</h3>
          <div className="progress-container">
            <div 
              className="progress-bar" 
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            ></div>
          </div>
          <div className="progress-text">
            {progress.current} / {progress.total} files processed ({Math.round((progress.current / progress.total) * 100)}%)
            {scanState === 'stopped' && ` - Stopped at user request`}
            {scanState === 'paused' && ` - Paused`}
          </div>
        </div>
      )}

      {!!events.length && (
        <div className="collapsible-section mt16">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setStatusExpanded(!statusExpanded)}
          >
            <span className="toggle-icon">{statusExpanded ? '▼' : '▶'}</span>
            <h3>Status</h3>
          </button>
          {statusExpanded && (
            <textarea
              readOnly
              rows={5}
              value={events.join('\n')}
              className="status-textarea"
              aria-label="Status events log"
              title="Status events log"
            />
          )}
        </div>
      )}

      {!!rows.length && (
        <div className="section-container mt16">
          <h3>Review & Edit</h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Apply</th><th>Source</th><th>Category</th><th>Filename</th><th>Ext</th><th>Proposed To</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: Row, i: number) => (
                  <tr key={i}>
                    <td><input aria-label={`Select ${r.src}`} type="checkbox" checked={!!r.enabled} onChange={e => updateRow(i, { enabled: e.target.checked })} /></td>
                    <td><code>{r.src}</code>{!r.enabled && <div className="muted">{r.reason || ''}</div>}</td>
                    <td><input aria-label={`Category for ${r.src}`} type="text" value={r.category} placeholder="Category" onChange={e => updateRow(i, { category: e.target.value })} /></td>
                    <td><input aria-label={`Name for ${r.src}`} type="text" value={r.name} placeholder="New filename" onChange={e => updateRow(i, { name: e.target.value })} /></td>
                    <td>{r.ext}</td>
                    <td>{toPath(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row mt16">
            <button className="secondary" onClick={optimizeCategories} disabled={busy}>
              {busy ? 'Optimizing...' : 'Optimize Categories'}
            </button>
            <button onClick={applyMoves} disabled={busy}>Approve Selected</button>
          </div>
        </div>
      )}

      <p className="note">
        AI file organization assistant.
      </p>
    </div>
  );
}