import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const SHORTCUTS: Array<[string, string]> = [
  ['图库 / 校准 / 分帧 / 调整 / 导出 / 设置', '顶部模块切换'],
  ['⌘/Ctrl + Z', '撤销（当前帧）'],
  ['⇧ + ⌘/Ctrl + Z', '重做'],
  ['G', '左右分割对比原片'],
  ['S', '保存当前帧'],
  ['[ / ]', '上一帧 / 下一帧'],
  ['⌘/Ctrl + 0', '适合窗口'],
  ['⌘/Ctrl + 1', '实际像素 100%'],
  ['⌘/Ctrl + + / −', '放大 / 缩小'],
  ['空格 + 拖动', '平移画布'],
  ['中键拖动', '平移画布'],
  ['双击滑块名称 / 数值', '复位该参数'],
  ['Delete / Backspace', '删除选中帧或曲线锚点'],
  ['Esc', '退出添加帧 / 关闭弹窗'],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="shortcut-help glass-surface-strong" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
        <div className="modal-heading">
          <div><p className="eyebrow">SHORTCUTS</p><h2 id="shortcut-help-title">快捷键</h2></div>
          <button ref={closeRef} className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys} className="shortcut-row">
              <kbd>{keys}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
