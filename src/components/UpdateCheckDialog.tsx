import React from 'react';
import { open as openUrl } from '@tauri-apps/api/shell';
import { AppUpdateInfo, LLMServerUpdateInfo } from '../api';

interface UpdateCheckDialogProps {
  isOpen: boolean;
  onClose: () => void;
  checking: boolean;
  appUpdateInfo: AppUpdateInfo | null;
  llmUpdateInfo: LLMServerUpdateInfo | null;
  error: string | null;
  llmProvider: string;
  onDownloadLLMUpdate: () => void;
  autoCheckUpdates: boolean;
  onToggleAutoCheckUpdates: () => void;
}

export default function UpdateCheckDialog({
  isOpen,
  onClose,
  checking,
  appUpdateInfo,
  llmUpdateInfo,
  error,
  llmProvider,
  onDownloadLLMUpdate,
  autoCheckUpdates,
  onToggleAutoCheckUpdates
}: UpdateCheckDialogProps) {
  if (!isOpen) return null;

  const handleViewAppUpdate = async () => {
    await openUrl('https://github.com/BorisBesky/file-organizer-desktop/releases/latest');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Check for Updates</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        
        <div className="modal-body">
          {checking && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <p>Checking for updates...</p>
            </div>
          )}

          {error && (
            <div className="update-message error" style={{ marginBottom: '16px' }}>
              <strong>Error:</strong> {error}
            </div>
          )}

          {!checking && !error && (
            <div className="updates-section">
              {/* App Update Status */}
              {appUpdateInfo && (
                <div className={`update-message ${appUpdateInfo.update_available ? 'update-available' : 'up-to-date'}`} style={{ marginBottom: '16px' }}>
                  <strong>File Organizer:</strong>
                  {appUpdateInfo.update_available && appUpdateInfo.latest_version ? (
                    <>
                      {' '}Update available! Version {appUpdateInfo.latest_version} (current: {appUpdateInfo.current_version})
                      <br />
                      <button 
                        className="button-primary"
                        onClick={handleViewAppUpdate}
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
              {llmProvider === 'managed-local' && llmUpdateInfo && (
                <div className={`update-message ${llmUpdateInfo.update_available ? 'update-available' : 'up-to-date'}`} style={{ marginBottom: '16px' }}>
                  <strong>LLM Server:</strong>
                  {llmUpdateInfo.update_available && llmUpdateInfo.latest_version ? (
                    <>
                      {' '}Update available! Version {llmUpdateInfo.latest_version} (current: {llmUpdateInfo.current_version || 'unknown'})
                      <br />
                      <button 
                        className="button-primary" 
                        onClick={onDownloadLLMUpdate}
                        style={{ marginTop: '8px' }}
                      >
                        Download Update
                      </button>
                    </>
                  ) : llmUpdateInfo.latest_version ? (
                    ` You're up to date! Version ${llmUpdateInfo.current_version || llmUpdateInfo.latest_version}`
                  ) : (
                    ' Unable to determine update status'
                  )}
                </div>
              )}

              {llmProvider !== 'managed-local' && (
                <div className="update-message" style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>
                  <strong>LLM Server:</strong> Not applicable (using {llmProvider})
                </div>
              )}

              {!appUpdateInfo && (!llmUpdateInfo || llmProvider !== 'managed-local') && (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)' }}>
                  No update information available
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer update-dialog-footer-with-checkbox">
          <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              checked={autoCheckUpdates}
              onChange={onToggleAutoCheckUpdates}
            />
            <span>Auto-check for updates on startup</span>
          </label>
          <div className="footer-buttons">
            <button className="button-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

