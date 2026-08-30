import type { ReactNode } from 'react';
import { Aperture, ChevronLeft, Settings2 } from 'lucide-react';

interface AppShellProps {
  children: ReactNode;
  mode: 'library' | 'editor';
  isMac: boolean;
  /** REL-04：版本号唯一来源 app.getVersion()，由 App 注入，禁止硬编码。 */
  appVersion?: string;
  context?: string[];
  statusText?: string;
  statusTone: 'safe' | 'danger';
  editorActions?: ReactNode;
  onBack?: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

export function AppShell({
  children,
  mode,
  isMac,
  appVersion,
  context = [],
  statusText,
  statusTone,
  editorActions,
  onBack,
  onOpenSettings,
  onOpenHelp,
}: AppShellProps) {
  return (
    <div className={`app-shell ${isMac ? 'macos' : ''} ${mode === 'editor' ? 'is-editor' : 'is-library'}`}>
      <header className="topbar glass-surface">
        <div className="brand-block">
          <div className="brand-mark"><Aperture size={20} strokeWidth={2.4} /></div>
          <div><h1 className="brand-name">Chromik <span>珂影</span></h1><div className="brand-subtitle">胶片工作室</div></div>
        </div>

        {mode === 'editor' ? (
          <><span className="topbar-context-divider" /><button className="editor-back" onClick={onBack}><ChevronLeft size={17} /><span>图库</span></button><div className="editor-identity" aria-label="当前文件位置">
            {context.map((item, index) => <span key={`${item}-${index}`}><b>{item}</b>{index < context.length - 1 && <i>/</i>}</span>)}
          </div></>
        ) : null}

        <div className="topbar-spacer" />
        {mode === 'editor' && <div className="editor-common-actions">{editorActions}</div>}
        <div className="top-status">
          <button className="icon-button top-settings" aria-label="设置" aria-keyshortcuts="Ctrl+Comma" title="设置" onClick={onOpenSettings}><Settings2 size={15} /></button>
          <button className="icon-button top-help" aria-label="快捷键（?）" aria-keyshortcuts="?" title="快捷键（?）" onClick={onOpenHelp}><span className="help-kbd">?</span></button>
          {statusText && <span className={`status-chip ${statusTone}`} role="status" aria-live="polite"><span className="status-dot" />{statusText}</span>}
          <span className="version">PREVIEW {appVersion ?? ''}</span>
        </div>
      </header>
      {children}
    </div>
  );
}
