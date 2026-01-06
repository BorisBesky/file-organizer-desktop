import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api';
import ManagedLLMDialog from './ManagedLLMDialog';
import { ManagedLLMConfig } from '../types';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  managedLLMConfig?: ManagedLLMConfig;
}

interface AppVersionInfo {
  version: string;
  build_timestamp: string;
}

export default function AboutDialog({
  isOpen,
  onClose,
  managedLLMConfig
}: AboutDialogProps) {
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);

  useEffect(() => {
    if (isOpen) {
      invoke<AppVersionInfo>('get_app_version')
        .then(setVersionInfo)
        .catch(err => console.error('Failed to fetch version:', err));
    }
  }, [isOpen]);

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

            <div className="modal-footer">
              <button className="button-primary" onClick={onClose}>Close</button>
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
          }}
          latestVersion={undefined}
          isUpdate={false}
          managedLLMConfig={managedLLMConfig}
        />
      )}
    </>
  );
}
