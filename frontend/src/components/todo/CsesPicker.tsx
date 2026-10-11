import { useEffect, useRef } from 'react';
import { useDailyChallengesStore } from '../../store/dailyChallengesStore';
import './todo.css';

interface CsesPickerProps {
  open: boolean;
  onClose: () => void;
}

export default function CsesPicker({ open, onClose }: CsesPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const {
    cses,
    csesRefresh,
    csesSelectTopic,
    csesRestart,
    csesRetry,
  } = useDailyChallengesStore();

  useEffect(() => {
    if (!open) return;
    void csesRefresh(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, csesRefresh]);

  if (!open) return null;

  const topics = cses?.topics ?? [];
  const activeTopicId = cses?.activeTopic?.id ?? null;
  const retryable = cses?.retryable ?? [];

  const handleSelect = async (topicId: string) => {
    await csesSelectTopic(topicId);
    onClose();
  };

  const handleRestart = async (topicId: string) => {
    await csesRestart(topicId);
    onClose();
  };

  const handleRetry = async (taskId: string) => {
    await csesRetry(taskId);
    onClose();
  };

  return (
    <div
      className="band-picker-overlay cses-picker-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="band-picker-modal cses-picker-modal"
        ref={ref}
        role="dialog"
        aria-label="CSES Topics and Retry"
      >
        <div className="band-picker-modal__header">
          <h2>CSES Topics</h2>
          <button
            type="button"
            className="band-picker-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="band-picker-modal__sub">
          One problem a day, topic-based. Take your time on each problem.
        </p>

        {/* Retryable Section */}
        {retryable.length > 0 && (
          <section className="cses-picker-section" aria-label="Retry skipped problems">
            <h3 className="cses-picker-section__title">
              Retry Skipped ({retryable.length})
            </h3>
            <p className="cses-picker-section__sub">
              Skipped problems of the current topic run. Retry brings the problem into today's slot.
            </p>
            <div className="cses-retry-list">
              {retryable.map((r) => (
                <div key={r.taskId} className="cses-retry-item">
                  <span className="cses-retry-item__title">
                    #{r.position} · {r.title}
                  </span>
                  <div className="cses-retry-item__actions">
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-ghost btn-sm"
                      >
                        View ↗
                      </a>
                    )}
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => void handleRetry(r.taskId)}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Topics List */}
        <section className="cses-picker-section" aria-label="CSES Topics list">
          <h3 className="cses-picker-section__title">All Topics (18)</h3>
          <div className="cses-topics-grid">
            {topics.map((t) => {
              const isActive = t.id === activeTopicId;
              const isComplete = t.state === 'complete';
              const run = t.current?.run ?? 1;

              return (
                <div
                  key={t.id}
                  className={`cses-topic-card${isActive ? ' is-active' : ''}`}
                >
                  <div className="cses-topic-card__header">
                    <span className="cses-topic-card__title">{t.title}</span>
                    {isActive && (
                      <span className="badge badge-brand">Active</span>
                    )}
                  </div>

                  <div className="cses-topic-card__progress">
                    {run > 1 && t.original ? (
                      <span className="t-meta">
                        Original {t.original.solved}/{t.original.total} · Restart {t.current?.solved ?? 0}/{t.total}
                      </span>
                    ) : (
                      <span className="t-meta">
                        {t.current?.solved ?? 0}/{t.total} solved
                        {t.current && t.current.skipped > 0 ? ` · ${t.current.skipped} skipped` : ''}
                      </span>
                    )}
                  </div>

                  <div className="cses-topic-card__actions">
                    {!isActive ? (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => void handleSelect(t.id)}
                      >
                        {t.state === 'fresh' ? 'Start' : 'Resume'}
                      </button>
                    ) : (
                      <span className="cses-topic-card__current-pill">Current</span>
                    )}

                    {isComplete && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => void handleRestart(t.id)}
                        title="Start a new review run while keeping your solved history and coins"
                      >
                        Restart
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
