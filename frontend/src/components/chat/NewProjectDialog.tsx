// New-project guided dialog.
//
// Two modes:
//   - Create new: user types a folder name; absolute path is built by
//     concatenating a remembered parent directory with the name.
//   - Use existing: user pastes an absolute path (same behaviour as the
//     old window.prompt flow, kept for when the folder already exists).
//
// The parent directory is persisted so the next "new project" doesn't
// make the user retype the parent path. Backend mkdir is
// idempotent, so both modes converge on the same create-if-missing
// action upstream; the only difference is how the path gets composed.

import { useEffect, useRef, useState } from 'react';
import { claudeApi } from '../../api/claudeApi';

const PARENT_KEY = 'chat-new-project-default-parent';

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (absolutePath: string) => void | Promise<void>;
}

type Mode = 'new' | 'existing';

function isAbsolute(path: string): boolean {
  return (
    /^[A-Za-z]:[/\\]/.test(path) ||
    path.startsWith('/') ||
    path.startsWith('\\\\')
  );
}

function normalize(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function NewProjectDialog({
  open,
  onClose,
  onSubmit,
}: NewProjectDialogProps) {
  const [mode, setMode] = useState<Mode>('new');
  const [parent, setParent] = useState<string>('');
  const [folderName, setFolderName] = useState<string>('');
  const [existingPath, setExistingPath] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // Ask the backend to spawn the OS native folder picker. This blocks
  // until the user picks or cancels on their own screen — no issue
  // since backend is local-only (127.0.0.1). On cancel, result.path is
  // null and we do nothing.
  const handleBrowse = async (target: 'parent' | 'existing') => {
    setBrowsing(true);
    try {
      const initial =
        target === 'parent' ? normalize(parent) : normalize(existingPath);
      const result = await claudeApi.pickFolder(initial || undefined);
      if (result.error) {
        window.alert(`Folder picker failed:\n${result.error}`);
        return;
      }
      if (!result.path) return; // user cancelled
      if (target === 'parent') setParent(result.path);
      else setExistingPath(result.path);
    } finally {
      setBrowsing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    try {
      setParent(localStorage.getItem(PARENT_KEY) || '');
    } catch {
      setParent('');
    }
    setFolderName('');
    setExistingPath('');
    setMode('new');
    // Focus the first meaningful input once the modal is visible
    const t = setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const normalizedParent = normalize(parent);
  const cleanName = folderName.trim().replace(/[/\\]+/g, '');
  const composedPath =
    normalizedParent && cleanName ? `${normalizedParent}/${cleanName}` : '';

  const validationError: string | null = (() => {
    if (mode === 'new') {
      if (!normalizedParent) return 'Enter a parent directory.';
      if (!isAbsolute(normalizedParent)) {
        return 'Parent directory must be an absolute path.';
      }
      if (!cleanName) return 'Enter a folder name.';
      return null;
    }
    const p = normalize(existingPath);
    if (!p) return 'Enter an absolute path.';
    if (!isAbsolute(p)) return 'Path must be absolute.';
    return null;
  })();

  const handleSubmit = async () => {
    if (validationError || submitting) return;
    const target =
      mode === 'new' ? composedPath : normalize(existingPath);
    if (mode === 'new') {
      try {
        localStorage.setItem(PARENT_KEY, normalizedParent);
      } catch {
        // Ignore quota / private-mode
      }
    }
    setSubmitting(true);
    try {
      await onSubmit(target);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[28rem] max-w-[90vw] bg-card-bg border border-card-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="px-5 py-4 border-b border-card-border">
          <h3 className="text-sm font-semibold text-text-primary">
            New Project
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Pick a folder for your chats. The folder will be created if it
            doesn't exist yet.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Mode selector */}
          <div className="flex gap-1 p-1 bg-card-border/30 rounded-md text-xs">
            <button
              onClick={() => setMode('new')}
              className={`flex-1 px-3 py-1.5 rounded transition-colors ${
                mode === 'new'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Create new folder
            </button>
            <button
              onClick={() => setMode('existing')}
              className={`flex-1 px-3 py-1.5 rounded transition-colors ${
                mode === 'existing'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Use existing folder
            </button>
          </div>

          {mode === 'new' ? (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Parent directory
                </label>
                <div className="flex gap-2">
                  <input
                    ref={firstInputRef}
                    type="text"
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                    placeholder="D:/Imperial/individual"
                    className="flex-1 px-3 py-2 bg-window-bg border border-card-border rounded text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => handleBrowse('parent')}
                    disabled={browsing}
                    className="px-3 py-2 text-xs bg-card-border/50 hover:bg-card-border text-text-primary rounded transition-colors disabled:opacity-50"
                    title="Pick folder via your OS file manager"
                  >
                    {browsing ? '...' : 'Browse'}
                  </button>
                </div>
                <p className="text-[10px] text-text-muted mt-1">
                  Remembered for next time.
                </p>
              </div>

              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  New folder name
                </label>
                <input
                  type="text"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="my-project"
                  className="w-full px-3 py-2 bg-window-bg border border-card-border rounded text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                  spellCheck={false}
                />
              </div>

              {composedPath && (
                <div className="px-3 py-2 rounded bg-card-border/30 text-[11px] font-mono text-text-secondary break-all">
                  → {composedPath}
                </div>
              )}
            </>
          ) : (
            <div>
              <label className="block text-xs text-text-secondary mb-1">
                Absolute path to existing folder
              </label>
              <div className="flex gap-2">
                <input
                  ref={firstInputRef}
                  type="text"
                  value={existingPath}
                  onChange={(e) => setExistingPath(e.target.value)}
                  placeholder="D:/Imperial/individual/my-project"
                  className="flex-1 px-3 py-2 bg-window-bg border border-card-border rounded text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => handleBrowse('existing')}
                  disabled={browsing}
                  className="px-3 py-2 text-xs bg-card-border/50 hover:bg-card-border text-text-primary rounded transition-colors disabled:opacity-50"
                  title="Pick folder via your OS file manager"
                >
                  {browsing ? '...' : 'Browse'}
                </button>
              </div>
            </div>
          )}

          {validationError && (
            <div className="text-xs text-red-400">{validationError}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-card-border flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!!validationError || submitting}
            className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
          >
            {submitting
              ? 'Creating…'
              : mode === 'new'
              ? 'Create & open'
              : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
