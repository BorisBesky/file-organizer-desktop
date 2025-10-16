import React, { useState } from 'react';
import { downloadManagedLLMServer } from '../api';

interface ManagedLLMDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onDownloadComplete: () => void;
}

export default function ManagedLLMDialog({ isOpen, onClose, onDownloadComplete }: ManagedLLMDialogProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState('0.1.0');

  if (!isOpen) return null;

  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);
    setDownloadProgress(0);

    try {
      // Simulate progress updates (in a real implementation, this would come from events)
      const progressInterval = setInterval(() => {
        setDownloadProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + 10;
        });
      }, 200);

      await downloadManagedLLMServer(version, (percent) => {
        setDownloadProgress(percent);
      });

      clearInterval(progressInterval);
      setDownloadProgress(100);
      
      setTimeout(() => {
        onDownloadComplete();
        onClose();
        setIsDownloading(false);
        setDownloadProgress(0);
      }, 500);
    } catch (err: any) {
      setError(err.message || 'Download failed');
      setIsDownloading(false);
      setDownloadProgress(0);
    }
  };

  const handleCancel = () => {
    if (!isDownloading) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog managed-llm-dialog">
        <div className="modal-header">
          <h3>Download Local LLM Server</h3>
        </div>
        
        <div className="modal-content">
          <p>
            The Local LLM Server component is not installed. This will download and install 
            the appropriate server binary for your platform from GitHub releases.
          </p>
          
          <div className="download-info">
            <div className="info-row">
              <strong>Platform:</strong> {navigator.platform}
            </div>
            <div className="info-row">
              <strong>Version:</strong> 
              <select 
                value={version} 
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVersion(e.target.value)}
                disabled={isDownloading}
                className="version-select"
              >
                <option value="0.1.0">v0.1.0 (Latest)</option>
              </select>
            </div>
            <div className="info-row">
              <strong>Size:</strong> ~50-100 MB (varies by platform)
            </div>
            <div className="info-row">
              <strong>Source:</strong> 
              <a
                href={`https://github.com/BorisBesky/file-organizer-desktop/releases/tag/llm-v${version}`}
                target="_blank"
                rel="noopener noreferrer"
                className="github-link"
              >
                GitHub Releases
              </a>
            </div>
          </div>

          {isDownloading && (
            <div className="download-progress">
              <div className="progress-label">
                Downloading server binary... {downloadProgress}%
              </div>
              <div className="progress-bar-container">
                <div 
                  className="progress-bar"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="error-message">
              <strong>Download failed:</strong> {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button 
            className="secondary"
            onClick={handleCancel}
            disabled={isDownloading}
          >
            Cancel
          </button>
          <button 
            className="primary"
            onClick={handleDownload}
            disabled={isDownloading}
          >
            {isDownloading ? 'Downloading...' : 'Download & Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
