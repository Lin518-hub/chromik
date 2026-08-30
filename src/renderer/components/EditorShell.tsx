import type { ReactNode } from 'react';
import { Aperture, Crop, ScanLine, SlidersHorizontal, Sparkles } from 'lucide-react';
import { EDITOR_TOOLS, type EditorContext, type EditorToolId } from '../navigation';

export interface EditorShellProps {
  activeTool: EditorToolId;
  context: EditorContext;
  inspectorTitle: string;
  scopeLabel: string;
  canvas: ReactNode;
  inspector: ReactNode;
  filmstrip: ReactNode;
  inspectorAction?: ReactNode;
  onToolChange: (tool: EditorToolId) => void;
}

const TOOL_ICONS = {
  calibrate: Aperture,
  segment: ScanLine,
  adjust: SlidersHorizontal,
  crop: Crop,
  dust: Sparkles,
} as const;

/** BUG-040：新增工具漏配图标时回退到通用图标，而不是运行时 undefined 崩溃。 */
function toolIcon(id: EditorToolId) {
  return TOOL_ICONS[id] ?? SlidersHorizontal;
}

export function EditorShell({
  activeTool,
  context,
  inspectorTitle,
  scopeLabel,
  canvas,
  inspector,
  filmstrip,
  inspectorAction,
  onToolChange,
}: EditorShellProps) {
  return (
    <section className="editor-shell view-enter">
      <aside className="editor-toolrail glass-surface" aria-label="编辑器工具">
        {EDITOR_TOOLS.filter((tool) => tool.isAvailable(context)).map((tool) => {
          const Icon = toolIcon(tool.id);
          return (
            <button
              key={tool.id}
              className={activeTool === tool.id ? 'active' : ''}
              title={`${tool.description} · ${tool.scopeLabel}`}
              onClick={() => onToolChange(tool.id)}
            >
              <Icon size={18} /><span>{tool.label}</span>
            </button>
          );
        })}
      </aside>

      <section className="editor-canvas-column">
        <div className="editor-canvas">{canvas}</div>
        <div className="editor-filmstrip glass-surface">{filmstrip}</div>
      </section>

      <aside className="editor-inspector panel glass-surface">
        <header className="editor-inspector-title">
          <div><b>{inspectorTitle}</b><span>{scopeLabel}</span></div>
          {inspectorAction}
        </header>
        <div className="editor-inspector-scroll">{inspector}</div>
      </aside>
    </section>
  );
}
