import React, { useEffect, useMemo, useState } from 'react';
import { classifyViaLMStudio, optimizeCategoriesViaLMStudio } from './api';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';

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
  const [lmBase, setLmBase] = useState('/lm');
  const [model, setModel] = useState('openai/gpt-oss-20b');
  const [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

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

  const categoriesHint = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r: Row) => { if (r.category) set.add(r.category); });
    return Array.from(set);
  }, [rows]);

  const scan = async () => {
    if (!directory) return alert('Pick a directory first');
    setBusy(true);
    setEvents([]);
    setRows([]);
    setProgress({ current: 0, total: 0 });
    const used = new Set<string>();
    const previews: any[] = [];

    const files: string[] = await invoke('read_directory', { path: directory });
    const processableFiles = files.filter(f => !splitPath(f).name.startsWith('.'));
    setProgress({ current: 0, total: processableFiles.length });

    let currentIndex = 0;
    for (const f of processableFiles) {
      currentIndex++;
      setProgress({ current: currentIndex, total: processableFiles.length });
      
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
          result = await classifyViaLMStudio({ baseUrl: lmBase, model, text, originalName: splitPath(f).name, categoriesHint });
        } catch (e: any) {
          result = { category_path: 'uncategorized', suggested_filename: f.replace(/\.[^/.]+$/, ''), confidence: 0, raw: { error: e?.message || String(e) } };
        }
        const ext = '.' + (f.split('.').pop() || '');
        const safe = sanitizeFilename(result.suggested_filename || f.replace(/\.[^/.]+$/, ''));
        const dir = sanitizeDirpath(result.category_path || 'uncategorized');
        const dst = `${directory}/${dir}/${safe}${ext}`;
        let finalDst = dst;
        let i = 1;
        while (used.has(finalDst)) { finalDst = `${directory}/${dir}/${safe}-${i}${ext}`; i += 1; }
        used.add(finalDst);
        info.llm = result;
        info.dst = finalDst;
        previews.push(info);
        setEvents((prev: string[]) => [...prev, `Classified ${f} -> ${dir} => ${finalDst}`]);
      } else {
        setEvents((prev: string[]) => [...prev, `Skipping ${f}: ${reason}`]);
        previews.push(info);
      }
    }

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
    setProgress({ current: 0, total: 0 });
    setBusy(false);
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
      const result = await optimizeCategoriesViaLMStudio({
        baseUrl: lmBase,
        model,
        directoryTree,
      });
      
      if (result.optimizations && result.optimizations.length > 0) {
        setEvents((prev: string[]) => [...prev, `Found ${result.optimizations.length} optimization suggestions:`]);
        
        // Apply optimizations to rows
        const updatedRows = rows.map(row => {
          const optimization = result.optimizations.find(opt => opt.from === row.category);
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

  const toPath = (r: Row) => `${directory}/${r.category}/${r.name}${r.ext}`;

  return (
    <div className="container">
      <h1>AI File Organizer</h1>
      <div className="row">
        <button onClick={pickDirectory} disabled={busy}>Pick Directory</button>
        <button onClick={scan} disabled={busy || !directory}>{busy ? 'Scanning...' : 'Preview'}</button>
        <span>{directory ? `Selected: ${directory}` : 'No directory selected'}</span>
      </div>
      <div className="row mt16">
        <label>LM Studio base: <input aria-label="LM Studio base" placeholder="http://localhost:1234/v1" className="w260" value={lmBase} onChange={e => setLmBase(e.target.value)} /></label>
        <label>Model: <input aria-label="Model" placeholder="openai/gpt-4o" className="w220" value={model} onChange={e => setModel(e.target.value)} /></label>
      </div>

      {busy && progress.total > 0 && (
        <div className="mt16">
          <h3>Progress</h3>
          <div className="progress-container">
            <div 
              className="progress-bar" 
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            ></div>
          </div>
          <div className="progress-text">
            {progress.current} / {progress.total} files processed ({Math.round((progress.current / progress.total) * 100)}%)
          </div>
        </div>
      )}

      {!!events.length && (
        <div className="mt16">
          <h3>Status</h3>
          <textarea
            readOnly
            rows={5}
            value={events.join('\n')}
            className="status-textarea"
            aria-label="Status events log"
            title="Status events log"
          />
        </div>
      )}

      {!!rows.length && (
        <div className="mt16">
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
          <div className="mt8">
            <button onClick={optimizeCategories} disabled={busy}>
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