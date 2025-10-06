import React from 'react';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
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
          <h3>AI File Organizer</h3>
          <p className="version">Version 0.1.0</p>
          <p className="description">
            An intelligent file organization assistant powered by AI. 
            Automatically categorize and rename your files using advanced language models.
          </p>
          
          <div className="about-features">
            <h4>Supported AI Providers:</h4>
            <ul>
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
            <p>Built with Tauri, React, and TypeScript</p>
            <p className="copyright">© 2025 File Organizer</p>
          </div>
        </div>

        <div className="modal-footer">
          <button className="button-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
