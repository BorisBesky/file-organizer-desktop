import React, { useState } from 'react';
import { debugLogger } from '../debug-logger';

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  const [exportStatus, setExportStatus] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);

  const handleExportDiagnostics = async () => {
    setIsExporting(true);
    setExportStatus('Saving...');
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `file-organizer-diagnostics-${timestamp}.txt`;
      const savedPath = await debugLogger.saveLogs(filename);
      setExportStatus(`✅ Saved to: ${savedPath}`);
      
      // Clear success message after 5 seconds
      setTimeout(() => setExportStatus(''), 5000);
    } catch (error) {
      setExportStatus(`❌ Failed to save: ${error}`);
      debugLogger.error('HELP_DIALOG', 'Failed to export diagnostics', { error });
      
      // Clear error message after 5 seconds
      setTimeout(() => setExportStatus(''), 5000);
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>File Organizer Help</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        
        <div className="modal-body">
          <section className="help-section">
            <h3>Quick Start</h3>
            <ol>
              <li><strong>Configure LLM Provider:</strong> Expand the LLM Provider section and select your preferred AI service (Managed Local LLM, LM Studio, Ollama, OpenAI, Anthropic, Groq, Gemini, or Custom).</li>
              <li><strong>Pick Directory:</strong> Click "Pick Directory" to select the folder containing files you want to organize.</li>
              <li><strong>Scan Files:</strong> Click "Scan" to analyze your files. The AI will categorize them and suggest new filenames.</li>
              <li><strong>Review & Edit:</strong> Check the suggestions in the table. You can modify categories and filenames as needed.</li>
              <li><strong>Apply Changes:</strong> Select the files you want to move (checkboxes) and click "Approve Selected".</li>
            </ol>
          </section>

          <section className="help-section">
            <h3>Features</h3>
            <ul>
              <li><strong>Pause/Resume:</strong> You can pause the scan at any time and resume later without losing progress.</li>
              <li><strong>Stop & Continue:</strong> Stop the scan to review current results, then continue if needed.</li>
              <li><strong>Optimize Categories:</strong> After scanning, click "Optimize Categories" to let AI suggest improvements to your category structure.</li>
              <li><strong>Include Subdirectories:</strong> Check this option to scan files in all subdirectories recursively.</li>
              <li><strong>Auto-Optimization:</strong> Categories are automatically optimized after each scan completes.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>LLM Providers</h3>
            <ul>
              <li><strong>Managed Local LLM:</strong> Run a local LLM server automatically managed by the app. Select a model and the server will be downloaded and started automatically. Runs on localhost:8000.</li>
              <li><strong>LM Studio:</strong> Local AI server. Start LM Studio and load a model first. Default: http://localhost:1234</li>
              <li><strong>Ollama:</strong> Local AI server. Install and run Ollama with a model like llama2 or mistral. Default: http://localhost:11434</li>
              <li><strong>OpenAI:</strong> Cloud service. Requires API key from platform.openai.com. Models: GPT-4, GPT-3.5-turbo.</li>
              <li><strong>Anthropic:</strong> Cloud service. Requires API key from console.anthropic.com. Models: Claude 3.5 Sonnet, Claude 3 Opus.</li>
              <li><strong>Groq:</strong> Fast cloud inference. Requires API key from console.groq.com. Models: Llama, Mixtral.</li>
              <li><strong>Google Gemini:</strong> Google AI service. Requires API key from ai.google.dev. Models: Gemini 2.0 Flash, Gemini 1.5 Pro.</li>
              <li><strong>Custom:</strong> Any OpenAI-compatible API endpoint.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>How It Works</h3>
            <p>The AI reads your file contents and:</p>
            <ol>
              <li>Classifies each file into a category path (e.g., "finance/taxes", "medical/bills").</li>
              <li>Suggests a descriptive filename based on content, including dates and provider names when detected.</li>
              <li>Assigns a confidence score (0-1) for each classification.</li>
            </ol>
            <p>Files are only moved when you explicitly approve them. Original files are preserved until you click "Approve Selected".</p>
          </section>

          <section className="help-section">
            <h3>💡 Tips</h3>
            <ul>
              <li>Test your LLM connection before scanning large directories.</li>
              <li>Start with a small folder to verify the AI categorizes files the way you want.</li>
              <li>Review the Status log to track progress and identify any errors.</li>
              <li>Edit categories and filenames in the table before applying changes.</li>
              <li>The app skips hidden files (starting with ".").</li>
              <li>Only text-readable files are classified. Binary files are skipped but logged.</li>
              <li>For the Managed Local LLM option, the app will automatically download and start a server for you - no manual setup required.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>⚠️ Important Notes</h3>
            <ul>
              <li>Always backup important files before using automated organization tools.</li>
              <li>Cloud LLM providers may charge based on API usage.</li>
              <li>File content is sent to the LLM provider for analysis (local providers keep data on your machine).</li>
              <li>The app requires read/write permissions for the selected directory.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>⌨️ Keyboard Shortcuts</h3>
            <ul>
              <li><strong>macOS:</strong> Help menu → File Organizer Help (or press this shortcut if configured)</li>
              <li><strong>Windows/Linux:</strong> Help menu → File Organizer Help</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>🔧 Troubleshooting</h3>
            <p>If you encounter issues with LLM connections or file organization:</p>
            <ul>
              <li><strong>Check LLM Configuration:</strong> Ensure your provider settings (URL, API key, model) are correct.</li>
              <li><strong>Test Connection:</strong> Use the "Test Connection" button in LLM Config to verify your setup.</li>
              <li><strong>Export Diagnostics:</strong> Click the button below to save detailed logs for debugging.</li>
            </ul>
            <button 
              className="button-secondary diagnostics-button" 
              onClick={handleExportDiagnostics}
              disabled={isExporting}
            >
              📊 {isExporting ? 'Saving...' : 'Export Diagnostic Logs'}
            </button>
            {exportStatus && (
              <p className="diagnostics-status">
                {exportStatus}
              </p>
            )}
            <p className="diagnostics-hint">
              Saves to your Downloads folder with detailed logs of all API requests, responses, and configuration.
              API keys are automatically sanitized for security.
            </p>
          </section>
        </div>

        <div className="modal-footer">
          <button className="button-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
