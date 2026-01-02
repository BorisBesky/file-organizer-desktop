import React, { useState } from 'react';
import { downloadManagedLLMServer, updateManagedLLMServer } from '../api';
import { ManagedLLMConfig } from '../types';

interface ManagedLLMDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onDownloadComplete: () => void;
  latestVersion?: string;
  isUpdate?: boolean;
  managedLLMConfig?: ManagedLLMConfig;
}

export default function ManagedLLMDialog({ 
  isOpen, 
  onClose, 
  onDownloadComplete, 
  latestVersion,
  isUpdate = false,
  managedLLMConfig
}: ManagedLLMDialogProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  
  // Always use the latest version, fallback to '0.1.0' if not available
  const version = latestVersion || '0.1.0';

  if (!isOpen) return null;

  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);
    setDownloadProgress(0);
    setStatusMessage('');

    try {
      if (isUpdate && managedLLMConfig) {
        // Use update function which handles backup/restore
        setStatusMessage('Stopping server and creating backup...');
        setDownloadProgress(10);
        
        // Small delay to show status
        await new Promise(resolve => setTimeout(resolve, 500));
        
        setStatusMessage('Downloading new version...');
        setDownloadProgress(30);
        
        await updateManagedLLMServer(version, managedLLMConfig, (percent) => {
          // Map progress to 30-90% range
          setDownloadProgress(30 + (percent * 0.6));
        });
        
        setStatusMessage('Verifying installation...');
        setDownloadProgress(95);
        await new Promise(resolve => setTimeout(resolve, 300));
      } else {
        // Fresh download
        setStatusMessage('Downloading server...');
        
        // Simulate progress updates
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
          clearInterval(progressInterval);
          setDownloadProgress(percent);
        });
        
        clearInterval(progressInterval);
      }

      setDownloadProgress(100);
      setStatusMessage(isUpdate ? 'Update completed successfully!' : 'Download completed successfully!');
      
      setTimeout(() => {
        onDownloadComplete();
        onClose();
        setIsDownloading(false);
        setDownloadProgress(0);
        setStatusMessage('');
      }, 500);
    } catch (err: any) {
      setError(err.message || (isUpdate ? 'Update failed' : 'Download failed'));
      setIsDownloading(false);
      setDownloadProgress(0);
      setStatusMessage('');
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
          <h3>{isUpdate ? 'Update Local LLM Server' : 'Download Local LLM Server'}</h3>
        </div>
        
        <div className="modal-content">
          <p>
            {isUpdate 
              ? `A new version of the Local LLM Server is available. The update process will:
                 • Stop the server if running
                 • Backup the existing installation
                 • Download and install the new version
                 • Restart the server if it was running
                 • Roll back to the backup if the update fails`
              : `The Local LLM Server component is not installed. This will download and install 
                 the appropriate server binary for your platform from GitHub releases.`
            }
          </p>
          
          <div className="download-info">
            <div className="info-row">
              <strong>Platform:</strong> {navigator.userAgent.includes('Win') ? 'Windows' : navigator.userAgent.includes('Mac') ? 'macOS' : 'Linux'}
            </div>
            <div className="info-row">
              <strong>Version:</strong> v{version} (Latest)
            </div>
            <div className="info-row">
              <strong>Size:</strong> {navigator.userAgent.includes('Win') ? '~ 10 MB' : navigator.userAgent.includes('Mac') ? '~ 90 MB' : '~ 90 MB'}
            </div>
          </div>

          {isDownloading && (
            <div className="download-progress">
              <div className="progress-label">
                {statusMessage || (isUpdate ? 'Updating server...' : 'Downloading server binary...')} {downloadProgress}%
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
              <strong>{isUpdate ? 'Update failed:' : 'Download failed:'}</strong> {error}
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
            {isDownloading ? (isUpdate ? 'Updating...' : 'Downloading...') : (isUpdate ? 'Update Server' : 'Download & Install')}
          </button>
        </div>
      </div>
    </div>
  );
}
