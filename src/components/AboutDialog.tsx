import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api';
import { open as openUrl } from '@tauri-apps/api/shell';
import { checkLLMServerUpdate, LLMServerUpdateInfo, checkAppUpdate, AppUpdateInfo } from '../api';
import ManagedLLMDialog from './ManagedLLMDialog';
import { ManagedLLMConfig } from '../types';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  llmProvider: string;
  autoCheckUpdates: boolean;
  onToggleAutoCheckUpdates: () => void;
  managedLLMConfig?: ManagedLLMConfig;
}

interface AppVersionInfo {
  version: string;
  build_timestamp: string;
}

export default function AboutDialog({ 
  isOpen, 
  onClose, 
  llmProvider,
  autoCheckUpdates,
  onToggleAutoCheckUpdates,
  managedLLMConfig
}: AboutDialogProps) {
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<LLMServerUpdateInfo | null>(null);
  const [appUpdateInfo, setAppUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);

  useEffect(() => {
    if (isOpen) {
      invoke<AppVersionInfo>('get_app_version')
        .then(setVersionInfo)
        .catch(err => console.error('Failed to fetch version:', err));
      
      // Reset update state when dialog opens
      setUpdateInfo(null);
      setAppUpdateInfo(null);
      setUpdateError(null);
    }
  }, [isOpen]);

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateInfo(null);
    setAppUpdateInfo(null);
    
    try {
      // Check both app and LLM server updates in parallel
      const [appInfo, llmInfo] = await Promise.all([
        checkAppUpdate(),
        llmProvider === 'managed-local' ? checkLLMServerUpdate() : Promise.resolve(null)
      ]);
      
      setAppUpdateInfo(appInfo);
      if (llmInfo) {
        setUpdateInfo(llmInfo);
      }
    } catch (error: any) {
      setUpdateError(error.message || 'Failed to check for updates');
    } finally {
      setCheckingUpdate(false);
    }
  };

  if (!isOpen && !showDownloadDialog) return null;

  return (
    <>
      {isOpen && !showDownloadDialog && (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal-content about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>About File Organizer</h2>
              <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
            </div>
            
            <div className="modal-body about-content">
              <div className="about-icon">📁</div>
              <h3>Automatic AI File Organizer</h3>
              <p className="version">
                Version {versionInfo?.version || 'Loading...'}
                {versionInfo?.build_timestamp && (
                  <span className="build-timestamp"> ({versionInfo.build_timestamp})</span>
                )}
              </p>
              <p className="description">
                An intelligent file organization assistant powered by AI.
                Automatically categorize and rename your files using advanced language models,
                including local servers that run entirely on your machine.
              </p>
              
              <div className="about-features">
                <h4>Supported AI Providers:</h4>
                <ul>
                  <li>Managed Local LLM (Auto-managed local server)</li>
                  <li>LM Studio (Local)</li>
                  <li>Ollama (Local)</li>
                  <li>OpenAI</li>
                  <li>Anthropic (Claude)</li>
                  <li>Groq</li>
                  <li>Google Gemini</li>
                  <li>Custom OpenAI-compatible APIs</li>
                </ul>
              </div>

              <div className="about-footer-info">
                <p className="copyright">© 2026 File Organizer</p>
              </div>
            </div>

            {/* Update Status Messages - Unified for App and LLM */}
            {(appUpdateInfo || updateInfo || updateError) && (
              <div className="modal-body" style={{ paddingTop: 0 }}>
                <div className="updates-section">
                  <h4 style={{ marginTop: 0, marginBottom: '12px' }}>Updates</h4>
                  
                  {/* App Update Status */}
                  {appUpdateInfo && (
                    <div className={`update-message ${appUpdateInfo.update_available ? 'update-available' : 'up-to-date'}`}>
                      <strong>File Organizer:</strong>
                      {appUpdateInfo.update_available && appUpdateInfo.latest_version ? (
                        <>
                          {' '}Update available! Version {appUpdateInfo.latest_version} (current: {appUpdateInfo.current_version})
                          <br />
                          <button 
                            className="button-primary"
                            onClick={async () => {
                              await openUrl('https://github.com/BorisBesky/file-organizer-desktop/releases/latest');
                            }}
                            style={{ marginTop: '8px' }}
                          >
                            Download from GitHub →
                          </button>
                        </>
                      ) : (
                        ` You're up to date! Version ${appUpdateInfo.current_version}`
                      )}
                    </div>
                  )}
                  
                  {/* LLM Server Update Status */}
                  {llmProvider === 'managed-local' && updateInfo && (
                    <div className={`update-message ${updateInfo.update_available ? 'update-available' : 'up-to-date'}`}>
                      <strong>LLM Server:</strong>
                      {updateInfo.update_available && updateInfo.latest_version ? (
                        <>
                          {' '}Update available! Version {updateInfo.latest_version} (current: {updateInfo.current_version || 'unknown'})
                          <br />
                          <button 
                            className="button-primary" 
                            onClick={() => setShowDownloadDialog(true)}
                            style={{ marginTop: '8px' }}
                          >
                            Download Update
                          </button>
                        </>
                      ) : updateInfo.latest_version ? (
                        ` You're up to date! Version ${updateInfo.current_version || updateInfo.latest_version}`
                      ) : (
                        ' Unable to determine update status'
                      )}
                    </div>
                  )}
                  
                  {updateError && (
                    <div className="update-message error">
                      {updateError}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="modal-footer about-footer-with-checkbox">
              <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={autoCheckUpdates}
                  onChange={onToggleAutoCheckUpdates}
                />
                <span>Auto-check for updates on startup</span>
              </label>
              <div className="footer-buttons">
                <button 
                  className="button-secondary" 
                  onClick={handleCheckForUpdates}
                  disabled={checkingUpdate}
                >
                  {checkingUpdate ? 'Checking...' : 'Check for Updates'}
                </button>
                <button className="button-primary" onClick={onClose}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Download Dialog */}
      {showDownloadDialog && (
        <ManagedLLMDialog
          isOpen={showDownloadDialog}
          onClose={() => {
            setShowDownloadDialog(false);
            // Don't close AboutDialog, just return to it
          }}
          onDownloadComplete={() => {
            setShowDownloadDialog(false);
            // Re-check for updates after download
            handleCheckForUpdates();
          }}
          latestVersion={updateInfo?.latest_version}
          isUpdate={updateInfo?.update_available && !!updateInfo?.current_version}
          managedLLMConfig={managedLLMConfig}
        />
      )}
    </>
  );
}
