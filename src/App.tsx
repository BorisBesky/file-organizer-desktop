import React, { useEffect, useMemo, useState } from 'react';
import { classifyViaLMStudio } from './api';
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
    const used = new Set<string>();
    const previews: any[] = [];

    const files: string[] = await invoke('read_directory', { path: directory });

    for (const f of files) {
      if (splitPath(f).name.startsWith('.')) continue;
      
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
      <h1>AI File Organizer (Desktop)</h1>
      <div className="row">
        <button onClick={pickDirectory} disabled={busy}>Pick Directory</button>
        <button onClick={scan} disabled={busy || !directory}>{busy ? 'Scanning...' : 'Preview'}</button>
        <span>{directory ? `Selected: ${directory}` : 'No directory selected'}</span>
      </div>
      <div className="row mt16">
        <label>LM Studio base: <input aria-label="LM Studio base" className="w260" value={lmBase} onChange={e => setLmBase(e.target.value)} /></label>
        <label>Model: <input aria-label="Model" className="w220" value={model} onChange={e => setModel(e.target.value)} /></label>
      </div>

      {!!events.length && (
        <div className="mt16">
          <h3>Status</h3>
          <ul>
            {events.map((e: string, i: number) => <li key={i} className="muted">{e}</li>)}
          </ul>
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
                    <td><input aria-label={`Category for ${r.src}`} type="text" value={r.category} onChange={e => updateRow(i, { category: e.target.value })} /></td>
                    <td><input aria-label={`Name for ${r.src}`} type="text" value={r.name} onChange={e => updateRow(i, { name: e.target.value })} /></td>
                    <td>{r.ext}</td>
                    <td>{toPath(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt8">
            <button onClick={applyMoves}>Approve Selected</button>
          </div>
        </div>
      )}

      <p className="note">
        Read, analyze, and suggest file organization structures.
      </p>
    </div>
  );
}