import React from 'react';
import { RotateCcw, ShieldAlert } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('UI boundary recovered from error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-[#070a10] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full tactical-panel rounded-md p-6 space-y-4 text-center">
            <div className="mx-auto w-10 h-10 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
            </div>
            <h2 className="font-display text-lg font-bold uppercase tracking-wide text-white">
              Görünüm Yeniden Başlatılıyor
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Harita katmanında beklenmedik bir kesinti oluştu. Komuta merkezini güvenle sıfırlayabilirsiniz.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs uppercase tracking-wider cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Komuta Merkezini Kurtar</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
