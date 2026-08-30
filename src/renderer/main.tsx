import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/** BUG-049：根级错误边界——App 顶层异常不再白屏，给出重启提示。 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 32, fontFamily: 'system-ui, sans-serif' }}>
          <section style={{ maxWidth: 460, textAlign: 'center' }}>
            <h1 style={{ margin: '0 0 10px', fontSize: 22 }}>Chromik 珂影遇到了意外错误</h1>
            <p style={{ color: '#8a7f66', margin: '0 0 16px' }}>请尝试重新加载窗口；如果问题反复出现，请保留截图并反馈。</p>
            <pre style={{ textAlign: 'left', background: 'rgba(0,0,0,.06)', borderRadius: 8, padding: 12, overflow: 'auto', fontSize: 12 }}>
              {this.state.error.message || String(this.state.error)}
            </pre>
            <button
              className="button-primary"
              style={{ marginTop: 16, minHeight: 40, padding: '0 18px', borderRadius: 10, border: 0, cursor: 'pointer' }}
              onClick={() => window.location.reload()}
            >
              重新加载窗口
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) {
  // BUG-049：root 节点缺失时给出可见错误而不是强断言崩溃。
  document.body.innerHTML = '<p style="padding:32px;font-family:system-ui">Chromik 启动失败：找不到页面挂载点。</p>';
  throw new Error('找不到页面挂载点 #root');
}

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
