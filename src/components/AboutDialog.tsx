import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api';
import { checkLLMServerUpdate, LLMServerUpdateInfo } from '../api';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  llmProvider: string;
  autoCheckUpdates: boolean;
  onToggleAutoCheckUpdates: () => void;
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
  onToggleAutoCheckUpdates 
}: AboutDialogProps) {
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<LLMServerUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      invoke<AppVersionInfo>('get_app_version')
        .then(setVersionInfo)
        .catch(err => console.error('Failed to fetch version:', err));
      
      // Reset update state when dialog opens
      setUpdateInfo(null);
      setUpdateError(null);
    }
  }, [isOpen]);

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateInfo(null);
    
    try {
      const info = await checkLLMServerUpdate();
      setUpdateInfo(info);
    } catch (error: any) {
      setUpdateError(error.message || 'Failed to check for updates');
    } finally {
      setCheckingUpdate(false);
    }
  };

  if (!isOpen) return null;

  return (
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

        {/* Update Status Messages */}
        {llmProvider === 'managed-local' && (updateInfo || updateError) && (
          <div className="modal-body" style={{ paddingTop: 0 }}>
            {updateInfo && (
              <div className={`update-message ${updateInfo.update_available ? 'update-available' : 'up-to-date'}`}>
                {updateInfo.update_available && updateInfo.latest_version ? (
                  <>
                    <strong>Update available!</strong>
                    <br />
                    Version {updateInfo.latest_version} (current: {updateInfo.current_version || 'unknown'})
                  </>
                ) : updateInfo.latest_version ? (
                  <>
                    <strong>You're up to date!</strong>
                    <br />
                    Version {updateInfo.current_version || updateInfo.latest_version}
                  </>
                ) : (
                  'Unable to determine update status'
                )}
              </div>
            )}
            
            {updateError && (
              <div className="update-message error">
                {updateError}
              </div>
            )}
          </div>
        )}

        <div className="modal-footer about-footer-with-checkbox">
          {llmProvider === 'managed-local' && (
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={autoCheckUpdates}
                onChange={onToggleAutoCheckUpdates}
              />
              <span>Auto-check for updates on startup</span>
            </label>
          )}
          <div className="footer-buttons">
            {llmProvider === 'managed-local' && (
              <button 
                className="button-secondary" 
                onClick={handleCheckForUpdates}
                disabled={checkingUpdate}
              >
                {checkingUpdate ? 'Checking...' : 'Check for Updates'}
              </button>
            )}
            <button className="button-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
