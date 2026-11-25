import React, { useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, Crosshair, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { AiPriorityAction, AiTacticalAdvice, HudSnapshot, ObstacleStats } from '../game/types';

interface AiCommanderPanelProps {
  hud: HudSnapshot;
  cityName: string;
  sectorSizeMeters: number;
  obstacleStats: ObstacleStats;
  onExecuteOrder: (
    action: AiPriorityAction,
    targetX: number,
    targetY: number
  ) => { ok: boolean; message: string };
  onJumpToMeters?: (x: number, y: number) => void;
  onStatusToast: (msg: string) => void;
}

const RISK_STYLES: Record<AiTacticalAdvice['riskLevel'], string> = {
  Düşük: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  Orta: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  Yüksek: 'bg-orange-500/20 text-orange-300 border-orange-500/50',
  Kritik: 'bg-rose-500/25 text-rose-300 border-rose-500/60',
};

export const AiCommanderPanel: React.FC<AiCommanderPanelProps> = ({
  hud,
  cityName,
  sectorSizeMeters,
  obstacleStats,
  onExecuteOrder,
  onJumpToMeters,
  onStatusToast,
}) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [advice, setAdvice] = useState<AiTacticalAdvice | null>(null);
  const [applied, setApplied] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const requestAdvice = useCallback(async () => {
    setLoading(true);
    setApplied(false);
    setRetryNote(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 14000);
    try {
      const resp = await fetch('/api/tactical-advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          cityName,
          sectorSizeMeters,
          zombiesAlive: hud.zombiesAlive,
          civiliansAlive: hud.civiliansAlive,
          civiliansEvacuated: hud.civiliansEvacuated,
          policeAlive: hud.policeAlive,
          soldiersAlive: hud.soldiersAlive,
          helicoptersRemaining: hud.helicoptersRemaining,
          barricadesRemaining: hud.barricadesRemaining,
          quarantineRemaining: hud.quarantineRemaining,
          missionTimeSec: hud.missionTimeSec,
          dayPhase: hud.dayPhase,
          outbreakCenter: hud.outbreakCenter,
          obstacleStats: {
            buildings: obstacleStats.buildings,
            bridges: obstacleStats.bridges ?? 0,
            barriers: obstacleStats.barriers,
          },
        }),
      });
      const data = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        advice?: AiTacticalAdvice;
        error?: string;
      } | null;

      if (!resp.ok || !data?.ok || !data.advice) {
        setRetryNote('Taktik analiz geçici olarak yanıt veremedi. Tekrar deneyin.');
        return;
      }
      setAdvice(data.advice);
    } catch {
      setRetryNote('Bağlantı zaman aşımına uğradı. Tekrar analiz isteyin.');
    } finally {
      window.clearTimeout(timer);
      setLoading(false);
    }
  }, [cityName, sectorSizeMeters, hud, obstacleStats]);

  useEffect(() => {
    const onToggleShortcut = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName || '')) return;
      if (e.code === 'KeyF') {
        setOpen((prev) => {
          const next = !prev;
          if (next && !advice && !loading) {
            void requestAdvice();
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onToggleShortcut);
    return () => window.removeEventListener('keydown', onToggleShortcut);
  }, [advice, loading, requestAdvice]);

  const handleOpenAndAnalyze = () => {
    if (!open) {
      setOpen(true);
      if (!advice && !loading) {
        void requestAdvice();
      }
    } else {
      setOpen(false);
    }
  };

  const handleApplyOrder = () => {
    if (!advice) return;
    const result = onExecuteOrder(advice.priorityAction, advice.targetX, advice.targetY);
    onJumpToMeters?.(advice.targetX, advice.targetY);
    onStatusToast(result.message);
    if (result.ok) {
      setApplied(true);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleOpenAndAnalyze}
        title="Gemini AI Taktik Komutan Desteği [F]"
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition-colors cursor-pointer shadow-lg ${
          open
            ? 'bg-amber-500 text-slate-950 border-amber-400'
            : 'tactical-panel border-amber-500/60 text-amber-300 hover:bg-amber-500/15'
        }`}
      >
        <Bot className="w-3.5 h-3.5" />
        <span>AI Taktik Komutan [F]</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin" />}
      </button>

      {open && (
        <div className="w-[310px] tactical-panel backdrop-blur-md rounded-md p-3 space-y-2.5 border border-amber-500/50 shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span className="font-display text-xs font-bold uppercase tracking-wider text-amber-300">
                Gemini Taktik Komutan
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={requestAdvice}
                disabled={loading}
                title="Canlı durumu yeniden analiz et"
                className="p-1 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="AI Panelini Kapat"
                className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {loading && !advice ? (
            <div className="py-5 flex flex-col items-center justify-center gap-2 text-xs text-slate-300">
              <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
              <span>Sahadaki zombi ve tahliye akışı analiz ediliyor...</span>
            </div>
          ) : retryNote && !advice ? (
            <div className="space-y-2 py-2 text-xs">
              <p className="text-amber-200 leading-relaxed">{retryNote}</p>
              <button
                type="button"
                onClick={requestAdvice}
                className="w-full py-1.5 px-3 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs cursor-pointer"
              >
                Yeniden Analiz Et
              </button>
            </div>
          ) : advice ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`px-2 py-0.5 rounded-xs text-[10px] font-bold uppercase border ${
                    RISK_STYLES[advice.riskLevel] || RISK_STYLES.Yüksek
                  }`}
                >
                  Risk: {advice.riskLevel}
                </span>
                <button
                  type="button"
                  onClick={() => onJumpToMeters?.(advice.targetX, advice.targetY)}
                  className="inline-flex items-center gap-1 text-[10px] font-mono-num text-sky-300 hover:text-sky-200 cursor-pointer"
                  title="Önerilen hedef koordinata odaklan"
                >
                  <Crosshair className="w-3 h-3" />
                  <span>
                    ({Math.round(advice.targetX)}m, {Math.round(advice.targetY)}m)
                  </span>
                </button>
              </div>

              <div className="text-slate-100 font-medium leading-snug">{advice.situation}</div>
              <p className="text-[11px] text-slate-400 leading-relaxed">{advice.rationale}</p>

              {retryNote && <p className="text-[10px] text-amber-300">{retryNote}</p>}

              <div className="pt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleApplyOrder}
                  disabled={loading}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded font-semibold text-xs transition-colors cursor-pointer ${
                    applied
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  }`}
                >
                  {applied ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Emir Uygulandı</span>
                    </>
                  ) : (
                    <span>Uygula: {advice.actionLabel}</span>
                  )}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
