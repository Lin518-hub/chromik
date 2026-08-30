import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

interface ViewErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string;
}

interface ViewErrorBoundaryState {
  error?: Error;
  /** BUG-050：记录出错时的 resetKey，只有真正切到不同视图才自动清错。 */
  errorKey?: string;
}

/**
 * Per-view crash isolation. `resetKey` clears an encountered error only when
 * the active view actually changes; the boundary itself remains mounted so
 * ordinary tool switching does not recreate the surrounding page.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previous: ViewErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey && this.state.errorKey !== this.props.resetKey) {
      this.setState({ error: undefined, errorKey: undefined });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="view-error glass-surface-strong" role="alert">
          <TriangleAlert size={34} />
          <h2>这个面板遇到了问题</h2>
          <p>其余部分不受影响，可以切换其他模块继续使用。</p>
          <pre>{this.state.error.message || String(this.state.error)}</pre>
          <button
            className="button-primary"
            onClick={() => {
              // BUG-050：确定性错误下“重新加载”不应无限循环——记录当前 key，
              // 同视图内重试失败后不再自动清错（用户可切视图离开）。
              this.setState((current) => ({ error: undefined, errorKey: current.errorKey ?? this.props.resetKey }));
            }}
          >
            重新加载面板
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
