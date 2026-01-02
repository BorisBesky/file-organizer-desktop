import React, { useEffect, useMemo, useState, useRef } from 'react';
import { classifyViaLLM, optimizeCategoriesViaLLM, LLMConfig, DEFAULT_CONFIGS, LLMProviderType, openFile, FileContent, checkLLMServerUpdate, checkAppUpdate } from './api';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { open as openUrl } from '@tauri-apps/api/shell';
import { ScanState, ManagedLLMConfig, SavedProcessedState } from './types';
import { LLMConfigPanel, HelpDialog, AboutDialog, ManagedLLMDialog } from './components';
import { debugLogger } from './debug-logger';

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
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = i >= 0 ? p.slice(0, i) : '';
  const file = i >= 0 ? p.slice(i + 1) : p;
  const j = file.lastIndexOf('.');
  const name = j >= 0 ? file.slice(0, j) : file;
  const ext = j >= 0 ? file.slice(j) : '';
  return { dir, name, ext };
}

// Get category based on file extension for non-text/non-image files
function getExtensionBasedCategory(ext: string): string {
  const extension = ext.toLowerCase().replace('.', '');
  
  const extensionCategories: Record<string, string> = {
    // Archives
    zip: 'Archives/Compressed',
    rar: 'Archives/Compressed',
    '7z': 'Archives/Compressed',
    tar: 'Archives/Compressed',
    gz: 'Archives/Compressed',
    bz2: 'Archives/Compressed',
    
    // Audio
    mp3: 'Media/Audio',
    wav: 'Media/Audio',
    flac: 'Media/Audio',
    aac: 'Media/Audio',
    ogg: 'Media/Audio',
    m4a: 'Media/Audio',
    wma: 'Media/Audio',
    
    // Video
    mp4: 'Media/Video',
    avi: 'Media/Video',
    mkv: 'Media/Video',
    mov: 'Media/Video',
    wmv: 'Media/Video',
    flv: 'Media/Video',
    webm: 'Media/Video',
    m4v: 'Media/Video',
    
    // Executables
    exe: 'Applications/Windows',
    msi: 'Applications/Windows',
    dmg: 'Applications/macOS',
    pkg: 'Applications/macOS',
    app: 'Applications/macOS',
    deb: 'Applications/Linux',
    rpm: 'Applications/Linux',
    appimage: 'Applications/Linux',
    
    // Fonts
    ttf: 'Fonts/TrueType',
    otf: 'Fonts/OpenType',
    woff: 'Fonts/Web',
    woff2: 'Fonts/Web',
    
    // 3D Models
    obj: '3D_Models/Objects',
    fbx: '3D_Models/FBX',
    stl: '3D_Models/STL',
    blend: '3D_Models/Blender',
    
    // Database
    db: 'Data/Database',
    sqlite: 'Data/Database',
    sql: 'Data/Database',
    
    // Disk Images
    iso: 'DiskImages/ISO',
    img: 'DiskImages/Image',
    
    // Other binary
    bin: 'Binary/Raw',
    dat: 'Binary/Data',
  };
  
  return extensionCategories[extension] || `Other/${extension.toUpperCase() || 'Unknown'}`;
}

function configsEqual(a?: LLMConfig, b?: LLMConfig) {
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.maxTokens === b.maxTokens &&
    a.maxTextLength === b.maxTextLength &&
    a.systemMessage === b.systemMessage &&
    a.supportsVision === b.supportsVision
  );
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
      debugLogger.error('APP_INIT', 'Failed to load LLM config from localStorage', { error });
    }
    // Return default config if no saved config exists
    return {
      provider: 'managed-local',
      baseUrl: 'http://127.0.0.1:8000',
      model: 'local-model',
      maxTokens: 4096,
      maxTextLength: 4096,
      systemMessage: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename.',
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
      debugLogger.error('APP_INIT', 'Failed to load provider configs from localStorage', { error });
    }
    return {};
  };

  const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLlmConfig());
  const [providerConfigs, setProviderConfigs] = useState<Record<string, LLMConfig>>(loadProviderConfigs());
  const defaultModel = (navigator.userAgent.includes('Mac') ? 'mlx-community/gemma-3n-E4B-it-lm-4bit' : 'MaziyarPanahi/gemma-3-1b-it-GGUF');
  const defaultModelFilename = (navigator.userAgent.includes('Mac') ? '' : 'gemma-3-1b-it-GGUF.gguf');
  
  // Track if we've already attempted to start the server to prevent duplicates
  const serverStartAttempted = useRef(false);
  
  // Track if this is the initial mount to prevent clearing saved state on mount
  const isInitialMount = useRef(true);
  
  // Managed LLM state
  const [managedLLMConfig, setManagedLLMConfig] = useState<ManagedLLMConfig>(() => {
    try {
      const saved = localStorage.getItem('managedLLMConfig');
      if (saved) {
        const config = JSON.parse(saved);
        // Migrate old field names to new snake_case format
        const migratedConfig: ManagedLLMConfig = {
          port: config.port || 8000,
          host: config.host || '127.0.0.1',
          model: config.model || defaultModel,
          model_filename: config.model_filename || defaultModelFilename,
          log_level: config.log_level || 'info', // Support both old and new field names
          model_path: config.model_path || config.modelPath,
          env_vars: config.env_vars || {},
          mmproj_repo_id: config.mmproj_repo_id,
          mmproj_filename: config.mmproj_filename,
          chat_format: config.chat_format
        };
        return migratedConfig;
      }
    } catch (error) {
      debugLogger.error('APP_INIT', 'Failed to load managed LLM config from localStorage', { error });
    }
    return {
      port: 8000,
      host: '127.0.0.1',
      model: defaultModel,
      model_filename: defaultModelFilename,
      log_level: 'info',
      env_vars: {}
    };
  });
  const [directories, setDirectories] = useState<string[]>([]);
  const [includeSubdirectories, setIncludeSubdirectories] = useState(false);
  const [useExistingCategories, setUseExistingCategories] = useState(false);
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const existingCategoriesRef = useRef<string[]>([]);
  const updateExistingCategories = (categories: string[]) => {
    existingCategoriesRef.current = categories;
    setExistingCategories(categories);
  };
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [optimizedCategories, setOptimizedCategories] = useState<{ categories: Set<string>; count: number; total: number }>({
    categories: new Set(),
    count: 0,
    total: 0,
  });
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [showOptimizationResult, setShowOptimizationResult] = useState(false);
  const optimizationCancelRef = useRef(false);
  
  // Search and replace state
  const [searchReplaceExpanded, setSearchReplaceExpanded] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchUseRegex, setSearchUseRegex] = useState(false);
  
  // LLM update check state
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(() => {
    try {
      const saved = localStorage.getItem('autoCheckUpdates');
      return saved ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });
  const [toastMessage, setToastMessage] = useState<{ message: string; type: 'info' | 'success' | 'error'; action?: { label: string; onClick: () => void } } | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const [pendingUpdateVersion, setPendingUpdateVersion] = useState<string | null>(null);
  const [showUpdateDownloadDialog, setShowUpdateDownloadDialog] = useState(false);
  
  // Sorting state
  const [sortBy, setSortBy] = useState<SortField>('source');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  
  // Sidebar width and collapse state
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  
  // Toggle sidebar collapse
  const toggleSidebarCollapse = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };
  
  // Scan control state
  const [scanState, setScanState] = useState<ScanState>('idle');
  const scanControlRef = useRef({
    shouldStop: false,
    currentFileIndex: 0,
    processedFiles: [] as any[],
    allFiles: [] as string[],
    used: new Set<string>(),
  });

  // Save LLM config to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('llmConfig', JSON.stringify(llmConfig));
    } catch (error) {
      debugLogger.error('APP_CONFIG', 'Failed to save LLM config to localStorage', { error });
    }

    setProviderConfigs(prev => {
      const current = prev[llmConfig.provider];
      if (configsEqual(current, llmConfig)) {
        return prev;
      }

      const updated = { ...prev, [llmConfig.provider]: llmConfig };
      try {
        localStorage.setItem('llmProviderConfigs', JSON.stringify(updated));
      } catch (error) {
        debugLogger.error('APP_CONFIG', 'Failed to save provider configs to localStorage', { error });
      }
      return updated;
    });
  }, [llmConfig]);

  // Save managed LLM config to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('managedLLMConfig', JSON.stringify(managedLLMConfig));
    } catch (error) {
      debugLogger.error('APP_CONFIG', 'Failed to save managed LLM config to localStorage', { error });
    }
  }, [managedLLMConfig]);

  // Auto-save processed state when scan completes or stops
  useEffect(() => {
    // Skip on initial mount to allow saved state to be restored first
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    
    if ((scanState === 'completed' || scanState === 'stopped') && rows.length > 0) {
      debugLogger.info('APP_STATE', 'Auto-saving state after scan completed/stopped', {
        scanState,
        rowCount: rows.length,
      });
      saveProcessedState();
    }
    // Clear saved state when scan is reset to idle with no rows
    if (scanState === 'idle' && rows.length === 0) {
      debugLogger.info('APP_STATE', 'Clearing saved state (idle with no rows)', { scanState, rowCount: rows.length });
      clearProcessedState();
    }
  }, [scanState, rows]);

  // Auto-save on app exit/unmount using beforeunload event
  useEffect(() => {
    const handleBeforeUnload = () => {
      debugLogger.info('APP_EXIT', 'beforeunload triggered, saving state', {
        rowCount: rows.length,
        directoryCount: directories.length,
        scanState,
      });
      if (rows.length > 0 && directories.length > 0) {
        saveProcessedState();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Also save on component unmount
      debugLogger.info('APP_EXIT', 'Component unmounting, saving state', {
        rowCount: rows.length,
        directoryCount: directories.length,
        scanState,
      });
      if (rows.length > 0 && directories.length > 0) {
        saveProcessedState();
      }
    };
  }, [rows, directories, scanState, progress, includeSubdirectories]);

  // Migrate old config format on first load
  useEffect(() => {
    try {
      const saved = localStorage.getItem('managedLLMConfig');
      if (saved) {
        const config = JSON.parse(saved);
        // Check if we need to migrate (has old field names)
        if (config.logLevel || config.modelPath || config.envVars) {
          debugLogger.info('APP_CONFIG', 'Migrating managed LLM config from old format', {});
          const migratedConfig: ManagedLLMConfig = {
            port: config.port || 8000,
            host: config.host || '127.0.0.1',
            model: config.model ||  defaultModel,
            model_filename: config.model_filename || defaultModelFilename,
            log_level: config.log_level || config.logLevel || 'info',
            model_path: config.model_path || config.modelPath,
            env_vars: config.env_vars || config.envVars || {},
            mmproj_repo_id: config.mmproj_repo_id,
            mmproj_filename: config.mmproj_filename,
            chat_format: config.chat_format
          };
          setManagedLLMConfig(migratedConfig);
          // Save the migrated config immediately
          localStorage.setItem('managedLLMConfig', JSON.stringify(migratedConfig));
        }
      }
    } catch (error) {
      debugLogger.error('APP_CONFIG', 'Failed to migrate managed LLM config', { error });
    }
  }, []); // Run only once on mount

  // Add global functions for debugging
  useEffect(() => {
    (window as any).clearManagedLLMConfig = () => {
      localStorage.removeItem('managedLLMConfig');
      window.location.reload();
    };
    (window as any).getManagedLLMConfig = () => {
      return JSON.parse(localStorage.getItem('managedLLMConfig') || '{}');
    };
    // Debug functions for processed state
    (window as any).getProcessedState = () => {
      const saved = localStorage.getItem('processedFilesState');
      if (saved) {
        const state = JSON.parse(saved);
        console.log('Processed State:', {
          rowCount: state.rows?.length || 0,
          directories: state.directories,
          scanState: state.scanState,
          timestamp: new Date(state.timestamp).toLocaleString(),
          minutesAgo: Math.round((Date.now() - state.timestamp) / 1000 / 60),
        });
        return state;
      } else {
        console.log('No processed state found in localStorage');
        return null;
      }
    };
    (window as any).clearProcessedState = () => {
      localStorage.removeItem('processedFilesState');
      console.log('Processed state cleared');
    };
    (window as any).saveCurrentState = () => {
      saveProcessedState();
      console.log('Current state saved manually');
    };
  }, []);

  // Auto-start managed LLM server when provider changes to managed-local
  useEffect(() => {
    if (llmConfig.provider === 'managed-local') {
      // Check if we've already attempted to start the server
      if (serverStartAttempted.current) {
        debugLogger.debug('MANAGED_LLM', 'Server start already attempted, skipping duplicate attempt', {});
        return;
      }
      
      // Mark that we're attempting to start the server
      serverStartAttempted.current = true;
      
      // Check if server is already running, if not, start it
      const checkAndStartServer = async () => {
        try {
          const { getManagedLLMServerStatus, startManagedLLMServer } = await import('./api');
          const status = await getManagedLLMServerStatus();
          
          debugLogger.info('MANAGED_LLM', 'Managed LLM server status', { status: status.status });
          
          if (status.status === 'stopped' || status.status === 'downloaded') {
            // Auto-start the server
            debugLogger.info('MANAGED_LLM', 'Starting managed LLM server with config', { config: managedLLMConfig });
            await startManagedLLMServer(managedLLMConfig);
            setEvents((prev: string[]) => ['Auto-started managed LLM server', ...prev]);
          } else {
            debugLogger.debug('MANAGED_LLM', 'Server already running or starting, skipping auto-start', {});
          }
        } catch (error: any) {
          debugLogger.error('MANAGED_LLM', 'Failed to auto-start managed LLM server', { error });
          setEvents((prev: string[]) => [`Failed to auto-start server: ${error.message}`, ...prev]);
          // Reset the flag on error so the user can try again
          serverStartAttempted.current = false;
        }
      };
      
      checkAndStartServer();
    } else {
      // Reset the flag when switching away from managed-local
      serverStartAttempted.current = false;
    }
  }, [llmConfig.provider]); // Removed managedLLMConfig from dependencies to prevent re-triggering

  // Function to load a provider's saved config
  const loadProviderConfig = (provider: string) => {
    const savedConfig = providerConfigs[provider];
    if (savedConfig) {
      setLlmConfig(savedConfig);
    }
  };

  // Snackbar state for undo actions
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarActionLabel, setSnackbarActionLabel] = useState<string | null>(null);
  const snackbarTimeoutRef = useRef<number | null>(null);
  const snackbarOnActionRef = useRef<(() => void) | null>(null);

  const hideSnackbar = () => {
    setSnackbarVisible(false);
    setSnackbarMessage('');
    setSnackbarActionLabel(null);
    if (snackbarTimeoutRef.current) {
      window.clearTimeout(snackbarTimeoutRef.current);
      snackbarTimeoutRef.current = null;
    }
    snackbarOnActionRef.current = null;
  };

  const showSnackbar = (message: string, actionLabel: string | null, onAction?: () => void, duration = 5000) => {
    // Clear any existing snackbar
    if (snackbarTimeoutRef.current) {
      window.clearTimeout(snackbarTimeoutRef.current);
      snackbarTimeoutRef.current = null;
    }
    snackbarOnActionRef.current = onAction || null;
    setSnackbarMessage(message);
    setSnackbarActionLabel(actionLabel);
    setSnackbarVisible(true);
    snackbarTimeoutRef.current = window.setTimeout(() => {
      hideSnackbar();
    }, duration) as unknown as number;
  };

  const resetProviderConfig = (provider: string) => {
    // Capture previous state for undo
    const prevProviderConfigs = { ...providerConfigs };
    const prevLlmConfig = { ...llmConfig };
    const prevManagedConfig = { ...managedLLMConfig };

    // Remove saved config
    setProviderConfigs(prev => {
      if (!(provider in prev)) return prev;
      const updated = { ...prev };
      delete updated[provider];
      try {
        localStorage.setItem('llmProviderConfigs', JSON.stringify(updated));
      } catch (err) {
        debugLogger.error('APP_CONFIG', 'Failed to save provider configs to localStorage', { err });
      }
      return updated;
    });

    // If currently using this provider, apply defaults immediately and clear related fields
    if (llmConfig.provider === provider) {
      const defaultCfg = DEFAULT_CONFIGS[provider as LLMProviderType] || {};
      const standardDefaults = {
        maxTokens: 4096,
        maxTextLength: 4096,
        systemMessage: 'Return only valid JSON (no markdown), with keys: category_path, suggested_filename.',
        customHeaders: undefined,
        supportsVision: false,
        apiKey: undefined,
      } as Partial<LLMConfig>;

      setLlmConfig(prev => ({
        ...prev,
        provider: provider as LLMProviderType,
        baseUrl: defaultCfg.baseUrl || '',
        model: defaultCfg.model || '',
        ...standardDefaults,
      } as LLMConfig));

      // If resetting managed-local provider, also reset Managed LLM config to defaults
      if (provider === 'managed-local') {
        const defaultModel = (navigator.userAgent.includes('Mac') ? 'mlx-community/gemma-3n-E4B-it-lm-4bit' : 'MaziyarPanahi/gemma-3-1b-it-GGUF');
        const defaultModelFilename = (navigator.userAgent.includes('Mac') ? '' : 'gemma-3-1b-it-GGUF.gguf');
        setManagedLLMConfig({
          port: 8000,
          host: '127.0.0.1',
          model: defaultModel,
          model_filename: defaultModelFilename,
          log_level: 'info',
          env_vars: {}
        });
      }
    }

    setEvents(prev => [`Reset ${provider} provider to defaults`, ...prev]);

    // Show undo snackbar
    showSnackbar(`Reset ${provider} to defaults`, 'Undo', () => {
      // Restore previous state
      setProviderConfigs(prevProviderConfigs);
      try {
        localStorage.setItem('llmProviderConfigs', JSON.stringify(prevProviderConfigs));
      } catch (err) {
        debugLogger.error('APP_CONFIG', 'Failed to restore provider configs to localStorage', { err });
      }
      setLlmConfig(prevLlmConfig);
      if (provider === 'managed-local') {
        setManagedLLMConfig(prevManagedConfig);
      }
      setEvents(prev => [`Restored ${provider} configuration (undo)`, ...prev]);
      hideSnackbar();
    });
  };

  // Removed the directory-selected event listener since we now use direct invoke

  // Show toast notification
  const showToast = (message: string, type: 'info' | 'success' | 'error' = 'info', action?: { label: string; onClick: () => void }) => {
    setToastMessage({ message, type, action });
    if (toastTimeoutRef.current) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, action ? 8000 : 4000); // Longer timeout if there's an action button
  };

  // Handle toggle auto-check updates
  const handleToggleAutoCheckUpdates = () => {
    const newValue = !autoCheckUpdates;
    setAutoCheckUpdates(newValue);
    localStorage.setItem('autoCheckUpdates', JSON.stringify(newValue));
  };

  // Handle search and replace in categories
  const handleSearchReplace = () => {
    if (!searchText) {
      showToast('Please enter a search term', 'error');
      return;
    }

    let matchCount = 0;
    
    try {
      const updatedRows = rows.map(row => {
        let category = row.category;
        let matched = false;

        if (searchUseRegex) {
          // Use regex pattern
          try {
            const flags = searchCaseSensitive ? 'g' : 'gi';
            const regex = new RegExp(searchText, flags);
            if (regex.test(category)) {
              category = category.replace(regex, replaceText);
              matched = true;
            }
          } catch (e) {
            throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        } else if (searchWholeWord) {
          // Match whole words only
          const regex = new RegExp(
            `\\b${searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            searchCaseSensitive ? 'g' : 'gi'
          );
          if (regex.test(category)) {
            category = category.replace(regex, replaceText);
            matched = true;
          }
        } else {
          // Match anywhere in the string
          const searchPattern = searchCaseSensitive ? searchText : searchText.toLowerCase();
          const categoryToSearch = searchCaseSensitive ? category : category.toLowerCase();
          
          if (categoryToSearch.includes(searchPattern)) {
            if (searchCaseSensitive) {
              category = category.split(searchText).join(replaceText);
            } else {
              // Case-insensitive replace
              const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
              category = category.replace(regex, replaceText);
            }
            matched = true;
          }
        }

        if (matched) {
          matchCount++;
        }

        return { ...row, category };
      });

      if (matchCount > 0) {
        setRows(updatedRows);
        showToast(`Replaced in ${matchCount} categor${matchCount === 1 ? 'y' : 'ies'}`, 'success');
      } else {
        showToast('No matches found', 'info');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Error performing search and replace', 'error');
    }
  };

  useEffect(() => {
    const unlistenHelp = listen('show-help', () => {
      setHelpOpen(true);
    });
    const unlistenAbout = listen('show-about', () => {
      setAboutOpen(true);
    });
    const unlistenOpenDirectory = listen('open-directory', () => {
      pickDirectory();
    });
    return () => {
      unlistenHelp.then(f => f());
      unlistenAbout.then(f => f());
      unlistenOpenDirectory.then(f => f());
    };
  }, []);

  // Auto-check for updates on startup (if enabled)
  useEffect(() => {
    if (autoCheckUpdates) {
      // Small delay to let the app settle
      const timer = setTimeout(async () => {
        try {
          // Check app updates
          const appUpdateInfo = await checkAppUpdate();
          if (appUpdateInfo.update_available && appUpdateInfo.latest_version) {
            showToast(
              `File Organizer update available: v${appUpdateInfo.latest_version}`,
              'info',
              {
                label: 'View',
                onClick: async () => {
                  await openUrl('https://github.com/BorisBesky/file-organizer-desktop/releases/latest');
                  setToastMessage(null);
                }
              }
            );
          }
          
          // Check LLM server updates if using managed-local
          if (llmConfig.provider === 'managed-local') {
            const updateInfo = await checkLLMServerUpdate();
            if (updateInfo.update_available && updateInfo.latest_version) {
              setPendingUpdateVersion(updateInfo.latest_version);
              showToast(
                `LLM Server update available: v${updateInfo.latest_version}`,
                'info',
                {
                  label: 'Download',
                  onClick: () => {
                    setToastMessage(null);
                    setShowUpdateDownloadDialog(true);
                  }
                }
              );
            }
          }
        } catch (error) {
          // Silent fail on startup check
          debugLogger.debug('UPDATE_CHECK', 'Startup update check failed', { error });
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [autoCheckUpdates, llmConfig.provider]);

  useEffect(() => {
    debugLogger.info('APP_INIT', 'Checking for saved session on mount', {});
    const savedState = loadProcessedState();
    if (savedState) {
      if (savedState.rows.length > 0) {
        debugLogger.info('APP_INIT', 'Auto-restoring saved session', { 
          rowCount: savedState.rows.length,
          directories: savedState.directories || []
        });
        restoreProcessedState(savedState);
      } else {
        debugLogger.info('APP_INIT', 'Saved session found but has no rows', {});
      }
    } else {
      debugLogger.info('APP_INIT', 'No saved session found', {});
    }
  }, []);


  const pickDirectory = async () => {
    try {
      const selectedDirs: string[] = await invoke('pick_directory');
      if (selectedDirs && selectedDirs.length > 0) {
        setDirectories(prev => {
          // Add new directories, avoiding duplicates
          const newDirs = selectedDirs.filter(dir => !prev.includes(dir));
          return [...prev, ...newDirs];
        });
        setEvents((prev: string[]) => [
          `Selected ${selectedDirs.length} director${selectedDirs.length === 1 ? 'y' : 'ies'}`,
          ...prev
        ]);
      }
    } catch (error: any) {
      // User cancelled or error occurred
      if (error && !error.includes('cancelled')) {
        setEvents((prev: string[]) => [`Error selecting directories: ${error}`, ...prev]);
      }
    }
  };

  // Save processed files state to localStorage
  const saveProcessedState = () => {
    if (directories.length === 0 || rows.length === 0) {
      return; // Nothing to save
    }

    try {
      const state: SavedProcessedState = {
        directories,
        includeSubdirectories,
        useExistingCategories,
        existingCategories,
        rows,
        processedFiles: scanControlRef.current.processedFiles,
        allFiles: scanControlRef.current.allFiles,
        currentFileIndex: scanControlRef.current.currentFileIndex,
        used: Array.from(scanControlRef.current.used),
        scanState,
        progress,
        timestamp: Date.now(),
      };

      localStorage.setItem('processedFilesState', JSON.stringify(state));
      debugLogger.info('APP_STATE', 'Saved processed files state', { 
        rowCount: rows.length, 
        directories 
      });
    } catch (error) {
      debugLogger.error('APP_STATE', 'Failed to save processed files state', { error });
    }
  };

  // Load processed files state from localStorage
  const loadProcessedState = (): SavedProcessedState | null => {
    try {
      const saved = localStorage.getItem('processedFilesState');
      if (saved) {
        const state: SavedProcessedState = JSON.parse(saved);
        // Handle backwards compatibility: convert old directory field to directories array
        if (state.directory && !state.directories) {
          state.directories = [state.directory];
        }
        const dirs = state.directories || [];
        debugLogger.info('APP_STATE', 'Found saved processed files state', {
          rowCount: state.rows.length,
          directories: dirs,
          age: Math.round((Date.now() - state.timestamp) / 1000 / 60) + ' minutes ago'
        });
        return state;
      }
    } catch (error) {
      debugLogger.error('APP_STATE', 'Failed to load processed files state', { error });
    }
    return null;
  };

  // Restore processed files state
  const restoreProcessedState = (state: SavedProcessedState) => {
    try {
      // Handle backwards compatibility: use directories if available, otherwise fall back to directory
      const dirs = state.directories || (state.directory ? [state.directory] : []);
      setDirectories(dirs);
      setIncludeSubdirectories(state.includeSubdirectories);
      setUseExistingCategories(state.useExistingCategories || false);
      updateExistingCategories(state.existingCategories || []);
      setRows(state.rows);
      setProgress(state.progress);
      setScanState(state.scanState === 'scanning' ? 'stopped' : state.scanState);
      
      scanControlRef.current = {
        shouldStop: false,
        currentFileIndex: state.currentFileIndex,
        processedFiles: state.processedFiles,
        allFiles: state.allFiles,
        used: new Set(state.used),
      };

      const minutesAgo = Math.round((Date.now() - state.timestamp) / 1000 / 60);
      setEvents((prev: string[]) => [
        `Loaded ${state.rows.length} previously processed files from ${minutesAgo} minute(s) ago`,
        ...prev
      ]);

      debugLogger.info('APP_STATE', 'Restored processed files state', { 
        rowCount: state.rows.length 
      });
    } catch (error) {
      debugLogger.error('APP_STATE', 'Failed to restore processed files state', { error });
      setEvents((prev: string[]) => ['Failed to restore previous session', ...prev]);
    }
  };

  // Clear saved processed state
  const clearProcessedState = () => {
    try {
      localStorage.removeItem('processedFilesState');
      debugLogger.info('APP_STATE', 'Cleared saved processed files state', {});
    } catch (error) {
      debugLogger.error('APP_STATE', 'Failed to clear processed files state', { error });
    }
  };

  // Scan directories to find existing subdirectories for use as categories
  const scanExistingSubdirectories = async (): Promise<string[]> => {
    const allSubdirs: Set<string> = new Set();
    
    for (const dir of directories) {
      try {
        const subdirs: string[] = await invoke('list_subdirectories', { path: dir });
        subdirs.forEach(subdir => allSubdirs.add(subdir));
      } catch (error: any) {
        debugLogger.error('SCAN_SUBDIRS', `Failed to scan subdirectories for ${dir}`, { error });
      }
    }
    
    const result = Array.from(allSubdirs).sort();
    debugLogger.info('SCAN_SUBDIRS', 'Found existing subdirectories', { count: result.length, subdirs: result });
    return result;
  };

  const stopScan = () => {
    if (scanState === 'scanning') {
      scanControlRef.current.shouldStop = true;
      setScanState('stopped');
      setEvents((prev: string[]) => ['Scan stopped by user', ...prev]);
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

    // Use suggestedName directly - it already has the extension removed
    // Don't call splitPath() again as it would incorrectly truncate filenames with dots (e.g., version numbers)
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
    // Save the processed state when scan completes or stops
    saveProcessedState();
    // Don't change scanState here - it should already be set to 'stopped' or 'completed'
  };

  const processRemainingFiles = async () => {
    const { allFiles, currentFileIndex, processedFiles, used } = scanControlRef.current;
    
    for (let i = currentFileIndex; i < allFiles.length; i++) {
      // Check for stop signal
      if (scanControlRef.current.shouldStop) {
        scanControlRef.current.currentFileIndex = i;
        setScanState('stopped'); // Ensure state is set before finalizing
        await finalizeScan();
        return;
      }
      
      const f = allFiles[i];
      scanControlRef.current.currentFileIndex = i + 1;
      setProgress({ current: i + 1, total: allFiles.length });
      
      let fileContent: FileContent | null = null;
      let text = '';
      let readable = false;
      let reason = 'unsupported';

      try {
        const contentJson = await invoke<string>('read_file_content', { path: f });
        fileContent = JSON.parse(contentJson);
        
        // Determine if the file is readable
        if (fileContent?.text) {
          text = fileContent.text;
          readable = true;
          
          // Set reason based on mime type
          if (fileContent.mime_type?.includes('pdf')) {
            reason = 'pdf';
          } else if (fileContent.mime_type?.includes('wordprocessingml')) {
            reason = 'docx';
          } else if (fileContent.mime_type?.includes('spreadsheetml')) {
            reason = 'xlsx';
          } else {
            reason = 'text';
          }
        } else if (fileContent?.image_base64) {
          readable = true;
          reason = 'image';
          text = ''; // No text content for images
        }
      } catch (e) {
        // File not supported or error reading
        reason = 'unsupported';
      }

      setEvents((prev: string[]) => [`Reading ${f} (${reason})`, ...prev]);
      const info: any = { src: f, readable, reason };
      const fileExt = '.' + (f.split('.').pop() || '');
      const originalName = splitPath(f).name;
      
      // Handle non-readable files (binary, unsupported) with extension-based categorization
      if (!readable) {
        const extCategory = getExtensionBasedCategory(fileExt);
        setEvents((prev: string[]) => [`Categorizing ${f} by extension -> ${extCategory}`, ...prev]);
        
        info.llm = {
          category_path: extCategory,
          suggested_filename: originalName,
          raw: { method: 'extension-based' }
        };
        
        const safe = sanitizeFilename(originalName);
        const dir = sanitizeDirpath(extCategory);
        const rootDir = findRootDirectory(f);
        const dst = rootDir ? `${rootDir}/${dir}/${safe}${fileExt}` : `${dir}/${safe}${fileExt}`;
        let finalDst = dst;
        let j = 1;
        while (used.has(finalDst)) { 
          finalDst = rootDir ? `${rootDir}/${dir}/${safe}-${j}${fileExt}` : `${dir}/${safe}-${j}${fileExt}`; 
          j += 1; 
        }
        used.add(finalDst);
        info.dst = finalDst;
        processedFiles.push(info);
        
        // Update rows from processedFiles to avoid duplicates
        setRows(processedFiles.map(convertToRow));
        continue;
      }
      
      // For readable files (text/images), use LLM classification
      setEvents((prev: string[]) => [`Classifying ${f}`, ...prev]);
      let result: { category_path: string; suggested_filename: string; raw?: any };
      
      // Build categories hint - use existing categories if enabled, otherwise use hints from already processed files
      const existingCategoriesList = existingCategoriesRef.current;
      const effectiveCategoriesHint = useExistingCategories && existingCategoriesList.length > 0 
        ? existingCategoriesList 
        : categoriesHint;
      
      try {
        result = await classifyViaLLM({ 
          config: llmConfig, 
          text, 
          originalName: originalName, 
          categoriesHint: effectiveCategoriesHint,
          fileContent: fileContent || undefined,
        });
        
        // If using existing categories, verify the result matches one of the existing categories
        if (useExistingCategories && existingCategoriesList.length > 0) {
          const suggestedCategory = result.category_path?.split('/')[0] || '';
          const matchesExisting = existingCategoriesList.some(cat => 
            cat.toLowerCase() === suggestedCategory.toLowerCase() ||
            result.category_path?.toLowerCase().startsWith(cat.toLowerCase())
          );
          
          if (!matchesExisting) {
            // Find the best matching existing category
            const bestMatch = existingCategoriesList.find(cat => 
              result.category_path?.toLowerCase().includes(cat.toLowerCase())
            ) || existingCategoriesList[0] || 'uncategorized';
            
            debugLogger.info('CLASSIFY', 'Adjusted category to match existing', { 
              original: result.category_path, 
              adjusted: bestMatch 
            });
            result.category_path = bestMatch;
          }
        }
      } catch (e: any) {
        result = { category_path: 'uncategorized', suggested_filename: originalName, raw: { error: e?.message || String(e) } };
      }
      
      // Use suggested_filename directly - it already has the extension removed by the LLM
      // Don't call splitPath() again as it would incorrectly truncate filenames with dots (e.g., version numbers)
      const safe = sanitizeFilename(result.suggested_filename || originalName);
      const dir = sanitizeDirpath(result.category_path || 'uncategorized');
      const rootDir = findRootDirectory(f);
      const dst = rootDir ? `${rootDir}/${dir}/${safe}${fileExt}` : `${dir}/${safe}${fileExt}`;
      let finalDst = dst;
      let j = 1;
      while (used.has(finalDst)) { 
        finalDst = rootDir ? `${rootDir}/${dir}/${safe}-${j}${fileExt}` : `${dir}/${safe}-${j}${fileExt}`; 
        j += 1; 
      }
      used.add(finalDst);
      info.llm = result;
      info.dst = finalDst;
      processedFiles.push(info);
      setEvents((prev: string[]) => [`Classified ${f} -> ${dir} => ${finalDst}`, ...prev]);
      
      // Update rows from processedFiles to avoid duplicates
      setRows(processedFiles.map(convertToRow));
    }
    
    // If we reach here, scan completed normally
    setScanState('completed');
    await finalizeScan();
  };

  const categoriesHint = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r: Row) => { if (r.category && r.category.toLowerCase().indexOf('uncategorized') != -1) set.add(r.category); else set.add('Uncategorized'); });
    const hints: string[] = Array.from(set);
    debugLogger.info('CATEGORIES_HINT', 'Categories hint', { hints });
    return hints.length > 0 ? hints.slice(0, Math.min(hints.length, 10)) : [];
  }, [rows]);

  // Helper function to find which directory a file belongs to
  const findRootDirectory = (filePath: string): string | null => {
    for (const dir of directories) {
      const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
      if (filePath.startsWith(normalizedDir)) {
        return dir;
      }
    }
    // Fallback: use the first directory if no match found
    return directories.length > 0 ? directories[0] : null;
  };


  const scan = async () => {
    if (directories.length === 0) {
      alert('Pick at least one directory first');
      return;
    }

    // Handle resume after a stop without recreating state
    if (scanState === 'stopped') {
      try {
        // Merge user edits from rows back into processedFiles before resuming
        const rowsBySrc = new Map(rows.map(row => [row.src, row]));
        scanControlRef.current.processedFiles = scanControlRef.current.processedFiles.map(file => {
          const editedRow = rowsBySrc.get(file.src);
          if (editedRow && file.llm) {
            // User edited this file, update the LLM result with user changes
            return {
              ...file,
              llm: {
                ...file.llm,
                category_path: editedRow.category,
                suggested_filename: editedRow.name,
              }
            };
          }
          return file;
        });
        
        scanControlRef.current.shouldStop = false;
        setBusy(true);
        setScanState('scanning');
        setEvents((prev: string[]) => ['Resuming scan with your changes...', ...prev]);
        setProgress({ current: scanControlRef.current.currentFileIndex, total: scanControlRef.current.allFiles.length });
        await processRemainingFiles();
      } catch (error: any) {
        setEvents((prev: string[]) => [`Error resuming scan: ${error.message || String(error)}`, ...prev]);
        setBusy(false);
        setScanState('stopped');
      }
      return;
    }

    // Starting a brand new scan
    scanControlRef.current = {
      shouldStop: false,
      currentFileIndex: 0,
      processedFiles: [],
      allFiles: [],
      used: new Set<string>(),
    };

    // Clear saved state when starting a new scan
    clearProcessedState();

    setBusy(true);
    setScanState('scanning');
    setEvents([]);
    setRows([]);
    // Reset any previous optimization markers when starting a fresh scan
    setOptimizedCategories({ categories: new Set(), count: 0, total: 0 });
    setProgress({ current: 0, total: 0 });

    try {
      // If using existing categories, scan subdirectories first
      if (useExistingCategories) {
        setEvents((prev: string[]) => ['Scanning for existing subdirectories...', ...prev]);
        const subdirs = await scanExistingSubdirectories();
        updateExistingCategories(subdirs);
        if (subdirs.length > 0) {
          setEvents((prev: string[]) => [`Found ${subdirs.length} existing categories: ${subdirs.join(', ')}`, ...prev]);
        } else {
          setEvents((prev: string[]) => ['No existing subdirectories found, will use standard classification', ...prev]);
        }
      } else {
        updateExistingCategories([]);
      }

      // Collect files from all selected directories
      let allFilesFromAllDirs: string[] = [];
      
      for (const directory of directories) {
        setEvents((prev: string[]) => [`Scanning directory: ${directory}`, ...prev]);
        const files: string[] = await invoke('read_directory', { path: directory, includeSubdirectories: includeSubdirectories });
        const processableFiles = files.filter(f => !splitPath(f).name.startsWith('.'));
        allFilesFromAllDirs = allFilesFromAllDirs.concat(processableFiles);
        setEvents((prev: string[]) => [`  Found ${processableFiles.length} files in ${directory}`, ...prev]);
      }

      scanControlRef.current.allFiles = allFilesFromAllDirs;
      setProgress({ current: 0, total: allFilesFromAllDirs.length });

      setEvents((prev: string[]) => [`Total: ${allFilesFromAllDirs.length} files to process from ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}`, ...prev]);

      // Start processing files
      await processRemainingFiles();
    } catch (error: any) {
      setEvents((prev: string[]) => [`Error reading directories: ${error.message || String(error)}`, ...prev]);
      setBusy(false);
      setScanState('idle');
    }
  };

  const optimizeCategories = async () => {
    if (!rows.length) return;
    
    setBusy(true);
    setIsOptimizing(true);
    setShowOptimizationResult(false);
    optimizationCancelRef.current = false;
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
      // Check for cancellation before making the API call
      if (optimizationCancelRef.current) {
        setEvents((prev: string[]) => ['Optimization cancelled by user', ...prev]);
        setBusy(false);
        setIsOptimizing(false);
        return;
      }
      
      const result = await optimizeCategoriesViaLLM({
        config: llmConfig,
        directoryTree,
      });
      
      // Check for cancellation after API call
      if (optimizationCancelRef.current) {
        setEvents((prev: string[]) => ['Optimization cancelled by user', ...prev]);
        setBusy(false);
        setIsOptimizing(false);
        return;
      }
      
      if (result.optimizations && result.optimizations.length > 0) {
        setEvents((prev: string[]) => [`Found ${result.optimizations.length} optimization suggestions`, ...prev]);
        
        // Track which categories were optimized
        const optimizedCats = new Set<string>();
        const totalOptimizations = result.optimizations.length;
        let appliedCount = 0;
        
        // Apply optimizations to rows
        const updatedRows = rows.map(row => {
          const optimization = result.optimizations.find((opt: { from: string; to: string; reason: string }) => opt.from === row.category);
          if (optimization) {
            optimizedCats.add(optimization.to);
            appliedCount++;
            // Update progress as we apply optimizations
            setOptimizedCategories({
              categories: new Set(optimizedCats),
              count: appliedCount,
              total: totalOptimizations,
            });
            setEvents((prev: string[]) => [`  ${optimization.from} → ${optimization.to}: ${optimization.reason}`, ...prev]);
            return { ...row, category: optimization.to };
          }
          return row;
        });
        
        setOptimizedCategories({
          categories: optimizedCats,
          count: totalOptimizations,
          total: totalOptimizations,
        });
        setRows(updatedRows);
        setEvents((prev: string[]) => [`Applied ${totalOptimizations} category optimizations successfully.`, ...prev]);
        setShowOptimizationResult(true);
        // Auto-dismiss after 3 seconds
        setTimeout(() => {
          setShowOptimizationResult(false);
        }, 3000);
      } else {
        setEvents((prev: string[]) => ['No optimizations suggested - directory structure looks good!', ...prev]);
        setOptimizedCategories({ categories: new Set(), count: 0, total: 0 });
        setShowOptimizationResult(true);
        // Auto-dismiss after 3 seconds
        setTimeout(() => {
          setShowOptimizationResult(false);
        }, 3000);
      }
    } catch (e: any) {
      if (optimizationCancelRef.current) {
        setEvents((prev: string[]) => ['Optimization cancelled by user', ...prev]);
      } else {
        setEvents((prev: string[]) => [`Failed to optimize categories: ${e?.message || String(e)}`, ...prev]);
      }
      setShowOptimizationResult(false);
    }
    
    setBusy(false);
    setIsOptimizing(false);
  };

  const cancelOptimization = () => {
    optimizationCancelRef.current = true;
    setEvents((prev: string[]) => ['Cancelling optimization...', ...prev]);
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
    
    // Clear saved state after applying changes
    clearProcessedState();
  };

  const updateRow = (i: number, patch: Partial<Row>) => {
    // If category is being updated manually, remove it from optimized set
    if (patch.category !== undefined) {
      const oldCategory = rows[i]?.category;
      if (oldCategory && optimizedCategories.categories.has(oldCategory)) {
        setOptimizedCategories(prev => {
          const updated = new Set(prev.categories);
          // Only remove if no other rows still use this category
          const stillUsed = rows.some((r, idx) => idx !== i && r.category === oldCategory);
          if (!stillUsed) {
            updated.delete(oldCategory);
          }
          return {
            categories: updated,
            count: updated.size,
            total: prev.total,
          };
        });
      }
    }
    setRows((prev: Row[]) => prev.map((r: Row, idx: number) => idx === i ? { ...r, ...patch } : r));
  };

  const resetScan = () => {
    setScanState('idle');
    setRows([]);
    setEvents([]);
    setDirectories([]);
    setIncludeSubdirectories(false);
    setUseExistingCategories(false);
    updateExistingCategories([]);
    setProgress({ current: 0, total: 0 });
    setBusy(false);
    setOptimizedCategories({ categories: new Set(), count: 0, total: 0 });
    setShowOptimizationResult(false);
    clearProcessedState(); // Clear saved state when resetting
    scanControlRef.current = {
      shouldStop: false,
      currentFileIndex: 0,
      processedFiles: [],
      allFiles: [],
      used: new Set<string>(),
    };
  };

  const toPath = (r: Row) => {
    const rootDir = findRootDirectory(r.src);
    return rootDir ? `${rootDir}/${r.category}/${r.name}${r.ext}` : `${r.category}/${r.name}${r.ext}`;
  };
  
  // Get relative path from the selected directories
  const getRelativePath = (fullPath: string) => {
    if (directories.length === 0) return fullPath;
    
    // Find which directory this file belongs to
    for (const dir of directories) {
      const dirWithSlash = dir.endsWith('/') ? dir : dir + '/';
      if (fullPath.startsWith(dirWithSlash)) {
        return fullPath.slice(dirWithSlash.length);
      }
    }
    return fullPath;
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

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = localStorage.getItem('appTheme');
    return (savedTheme === 'dark' || savedTheme === 'light') ? savedTheme : 'light';
  });

  const [fontSizeMultiplier, setFontSizeMultiplier] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('fontSizeMultiplier');
      if (saved) {
        const parsed = parseFloat(saved);
        // Clamp between 0.5 and 2.0 for reasonable bounds
        return isNaN(parsed) ? 1.0 : Math.max(0.5, Math.min(2.0, parsed));
      }
    } catch (error) {
      debugLogger.error('APP_INIT', 'Failed to load font size multiplier from localStorage', { error });
    }
    return 1.0;
  });

  useEffect(() => {
    document.body.classList.toggle('dark-theme', theme === 'dark');
    localStorage.setItem('appTheme', theme);
  }, [theme]);

  useEffect(() => {
    // Apply font size multiplier as CSS variable
    document.documentElement.style.setProperty('--font-size-multiplier', fontSizeMultiplier.toString());
    localStorage.setItem('fontSizeMultiplier', fontSizeMultiplier.toString());
  }, [fontSizeMultiplier]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const increaseFontSize = () => {
    setFontSizeMultiplier(prev => Math.min(2.0, prev + 0.1));
  };

  const decreaseFontSize = () => {
    setFontSizeMultiplier(prev => Math.max(0.5, prev - 0.1));
  };

  // Keyboard shortcuts for font size
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Check for Ctrl+Plus/Minus (Windows/Linux) or Cmd+Plus/Minus (Mac)
      const isMac = navigator.userAgent.includes('Mac');
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;
      
      if (modifierKey && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault();
        if (e.key === '+' || e.key === '=') {
          setFontSizeMultiplier(prev => Math.min(2.0, prev + 0.1));
        } else if (e.key === '-') {
          setFontSizeMultiplier(prev => Math.max(0.5, prev - 0.1));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div className="app-layout">
      {/* Progress/Status Header */}
      <div className="app-header">
        <div className="header-content">
          {(busy || scanState !== 'idle') && progress.total > 0 && (
            <div className="header-progress">
              <div className="progress-label">
                {scanState === 'completed' 
                  ? 'File Analysis Completed' 
                  : scanState === 'stopped'
                  ? 'File Analysis Stopped'
                  : `Progress - ${scanState.charAt(0).toUpperCase() + scanState.slice(1)}`
                }
              </div>
              <div className="progress-container">
                <div 
                  className={`progress-bar ${scanState === 'completed' ? 'progress-bar-completed' : scanState === 'stopped' ? 'progress-bar-stopped' : ''}`}
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <div className="progress-text">
                {scanState === 'organizing' 
                  ? `${progress.current} out of ${progress.total} files moved`
                  : scanState === 'completed'
                  ? `Successfully analyzed ${progress.total} files`
                  : scanState === 'stopped'
                  ? `Analyzed ${progress.current} of ${progress.total} files before stopping`
                  : `${progress.current} / ${progress.total} files`
                } {scanState !== 'completed' && scanState !== 'stopped' && `(${Math.round((progress.current / progress.total) * 100)}%)`}
              </div>
            </div>
          )}
          
          {(isOptimizing || showOptimizationResult) && (
            <div className="header-progress">
              <div className="progress-label">
                {isOptimizing ? 'Optimizing Directory Structure' : 'Optimization Complete'}
              </div>
              <div className="progress-container">
                {optimizedCategories.total > 0 ? (
                  <div 
                    className="progress-bar progress-bar-completed"
                    style={{ width: `${(optimizedCategories.count / optimizedCategories.total) * 100}%` }}
                  />
                ) : (
                  <div className="progress-bar progress-bar-indeterminate" />
                )}
              </div>
              <div className="progress-text">
                {optimizedCategories.total > 0 
                  ? `Applied ${optimizedCategories.count} of ${optimizedCategories.total} optimizations`
                  : isOptimizing
                  ? 'Analyzing categories and generating optimization suggestions...'
                  : 'No optimizations suggested - directory structure looks good!'
                }
                {isOptimizing && (
                  <button 
                    className="cancel-optimization-btn"
                    onClick={cancelOptimization}
                    title="Cancel optimization"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {!!events.length && (
            <div className="header-status">
              <div className="status-header-row">
                <button
                  type="button"
                  className="status-toggle"
                  onClick={() => setStatusExpanded(!statusExpanded)}
                >
                  <span className="toggle-icon">{statusExpanded ? '▼' : '▶'}</span>
                  <span>Status Log</span>
                </button>
                <div className="status-latest">
                  {events[0]}
                </div>
              </div>
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
          
          <div className="header-toggle-container">
            <button 
              className="theme-toggle" 
              onClick={toggleSidebarCollapse}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              ☰
            </button>
            <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}>
              {theme === 'light' ? '☀️' : '🌙'}
            </button>
            <div className="header-scan-buttons">
              <button 
                onClick={scan} 
                disabled={busy || directories.length === 0 || scanState === 'scanning'}
              >
                {scanState === 'scanning' ? 'Scanning...' : scanState === 'stopped' ? 'Resume Scan' : 'Start Scan'}
              </button>
              
              {scanState === 'scanning' && (
                <button className="danger" onClick={stopScan} disabled={!busy}>Stop</button>
              )}
              
              {(scanState === 'completed' || scanState === 'stopped') && (
                <button className="secondary" onClick={resetScan}>New Scan</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Layout: Sidebar + Content */}
      <div className="app-main">
        {/* Left Sidebar */}
        <aside className="app-sidebar" style={{ width: sidebarCollapsed ? '0px' : `${sidebarWidth}px` }}>
          {!sidebarCollapsed && (
            <>
              {/* LLM Configuration */}
              <LLMConfigPanel
                config={llmConfig}
                onChange={setLlmConfig}
                onTest={testLLMConnection}
                disabled={busy}
                providerConfigs={providerConfigs}
                onLoadProviderConfig={loadProviderConfig}
                onResetProviderConfig={resetProviderConfig}
                managedLLMConfig={managedLLMConfig}
                onManagedLLMConfigChange={setManagedLLMConfig}
              />

              {/* Directory Picker Section */}
              <div className="sidebar-section">
                <button onClick={pickDirectory} disabled={busy || scanState === 'scanning' || scanState === 'stopped'} className="w-full">
                  Select Directories
                </button>
                {directories.length > 0 && (
                  <div className="directories-list">
                    {directories.map((dir, index) => (
                      <div key={index} className="directory-item">
                        <div className="directory-display" title={dir}>{dir}</div>
                        <button
                          className="directory-remove-btn"
                          onClick={() => setDirectories(directories.filter((_, i) => i !== index))}
                          disabled={busy || scanState === 'scanning' || scanState === 'stopped'}
                          title="Remove directory"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <label className="mt8">
                  <input 
                    type="checkbox" 
                    checked={includeSubdirectories} 
                    onChange={e => setIncludeSubdirectories(e.target.checked)}
                    disabled={busy || scanState === 'scanning' || scanState === 'stopped'}
                  />
                  Include subdirectories
                </label>
                <label className="mt8" title="Classify files into existing subdirectories only. Files that don't match will be categorized by extension.">
                  <input 
                    type="checkbox" 
                    checked={useExistingCategories} 
                    onChange={e => setUseExistingCategories(e.target.checked)}
                    disabled={busy || scanState === 'scanning' || scanState === 'stopped'}
                  />
                  Use existing subdirectories as categories
                </label>
                {useExistingCategories && existingCategories.length > 0 && (
                  <div className="existing-categories-preview">
                    <small>Categories: {existingCategories.slice(0, 5).join(', ')}{existingCategories.length > 5 ? ` (+${existingCategories.length - 5} more)` : ''}</small>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
        
        {/* Sidebar Resize Handle */}
        {!sidebarCollapsed && (
          <div className="sidebar-resize-handle" onMouseDown={handleSidebarResizeStart} />
        )}

        {/* Main Content Area */}
        <main className="app-content">
          {!!rows.length ? (
            <div className="content-section">
              <div className="content-header">
                <h2>Review & Edit Proposals</h2>
                <div className="button-row">
                  <button className="secondary" onClick={optimizeCategories} disabled={busy || useExistingCategories}>
                    Optimize Categories
                  </button>
                  <button 
                    className="secondary" 
                    onClick={() => setSearchReplaceExpanded(!searchReplaceExpanded)} 
                    disabled={rows.length === 0}
                  >
                    {searchReplaceExpanded ? 'Hide Find & Replace' : 'Find & Replace'}
                  </button>
                  <button onClick={applyMoves} disabled={busy}>Approve Selected</button>
                </div>
              </div>
              
              {/* Search and Replace Form */}
              {searchReplaceExpanded && (
                <div className="search-replace-form">
                  <div className="search-replace-inputs">
                    <div className="search-replace-field">
                      <label htmlFor="search-text">Find:</label>
                      <input
                        id="search-text"
                        type="text"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        placeholder="Search in categories"
                        disabled={rows.length === 0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && searchText) handleSearchReplace();
                        }}
                      />
                    </div>
                    <div className="search-replace-field">
                      <label htmlFor="replace-text">Replace:</label>
                      <input
                        id="replace-text"
                        type="text"
                        value={replaceText}
                        onChange={(e) => setReplaceText(e.target.value)}
                        placeholder="Replacement text"
                        disabled={rows.length === 0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && searchText) handleSearchReplace();
                        }}
                      />
                    </div>
                    <button 
                      className="search-replace-button"
                      onClick={handleSearchReplace} 
                      disabled={!searchText || rows.length === 0}
                      title="Replace all matches in categories"
                    >
                      Replace All
                    </button>
                  </div>
                  <div className="search-replace-options">
                    <label title="Match exact case">
                      <input
                        type="checkbox"
                        checked={searchCaseSensitive}
                        onChange={(e) => setSearchCaseSensitive(e.target.checked)}
                        disabled={rows.length === 0}
                      />
                      Case sensitive
                    </label>
                    <label title="Match whole words only">
                      <input
                        type="checkbox"
                        checked={searchWholeWord}
                        onChange={(e) => setSearchWholeWord(e.target.checked)}
                        disabled={rows.length === 0 || searchUseRegex}
                      />
                      Whole word
                    </label>
                    <label title="Use regular expression pattern">
                      <input
                        type="checkbox"
                        checked={searchUseRegex}
                        onChange={(e) => {
                          setSearchUseRegex(e.target.checked);
                          if (e.target.checked) setSearchWholeWord(false);
                        }}
                        disabled={rows.length === 0}
                      />
                      Regex
                    </label>
                  </div>
                </div>
              )}
              
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
                      const isOptimized = optimizedCategories.categories.has(r.category);
                      return (
                        <tr key={originalIndex} className={isOptimized ? 'optimized-row' : ''}>
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
                          <td>
                            <input 
                              aria-label={`Category for ${r.src}`} 
                              type="text" 
                              value={r.category} 
                              placeholder="Category" 
                              onChange={e => updateRow(originalIndex, { category: e.target.value })}
                              className={isOptimized ? 'optimized-category' : ''}
                            />
                          </td>
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
      <AboutDialog 
        isOpen={aboutOpen} 
        onClose={() => setAboutOpen(false)} 
        llmProvider={llmConfig.provider}
        autoCheckUpdates={autoCheckUpdates}
        onToggleAutoCheckUpdates={handleToggleAutoCheckUpdates}
        managedLLMConfig={managedLLMConfig}
      />

      {/* Update Download Dialog from Toast */}
      <ManagedLLMDialog
        isOpen={showUpdateDownloadDialog}
        onClose={() => setShowUpdateDownloadDialog(false)}
        onDownloadComplete={() => {
          setShowUpdateDownloadDialog(false);
          setPendingUpdateVersion(null);
          showToast('LLM Server update installed successfully', 'success');
        }}
        latestVersion={pendingUpdateVersion || undefined}
        isUpdate={true}
        managedLLMConfig={managedLLMConfig}
      />

      {/* Snackbar for undo actions */}
      {snackbarVisible && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            right: '20px',
            bottom: '20px',
            background: '#333',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: '6px',
            boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            zIndex: 9999,
          }}
        >
          <div style={{ fontSize: '0.95rem' }}>{snackbarMessage}</div>
          {snackbarActionLabel && (
            <button
              onClick={() => {
                if (snackbarOnActionRef.current) snackbarOnActionRef.current();
              }}
              style={{
                background: 'transparent',
                color: '#ffd54f',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '4px',
                padding: '6px 10px',
                cursor: 'pointer'
              }}
            >
              {snackbarActionLabel}
            </button>
          )}
          <button
            onClick={hideSnackbar}
            aria-label="Dismiss notification"
            style={{
              background: 'transparent',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.2rem',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            backgroundColor: toastMessage.type === 'error' ? '#f44336' : toastMessage.type === 'success' ? '#4caf50' : '#2196f3',
            color: '#fff',
            padding: '12px 20px',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            zIndex: 10000,
            maxWidth: '400px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            animation: 'slideInRight 0.3s ease-out',
          }}
        >
          <span style={{ flex: 1 }}>{toastMessage.message}</span>
          {toastMessage.action && (
            <button
              onClick={toastMessage.action.onClick}
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.5)',
                cursor: 'pointer',
                fontSize: '0.9rem',
                padding: '6px 12px',
                borderRadius: '4px',
                fontWeight: 600,
              }}
            >
              {toastMessage.action.label}
            </button>
          )}
          <button
            onClick={() => setToastMessage(null)}
            aria-label="Close toast"
            style={{
              background: 'transparent',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.2rem',
              lineHeight: 1,
              padding: '0',
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
