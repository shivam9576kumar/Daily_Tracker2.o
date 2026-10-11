import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DailyChallengeMeta, Rating, Task } from '../../types';
import { useDailyChallengesStore } from '../../store/dailyChallengesStore';
import { useUIStore } from '../../store/uiStore';
import { dailyChallengesApi } from '../../services/dailyChallengesApi';
import { getErrorMessage } from '../../services/api';
import TodoTaskRow from './TodoTaskRow';
import CsesBlock from './CsesBlock';
import CsesPicker from './CsesPicker';
import './todo.css';

interface DailyChallengesSectionProps {
  meta: DailyChallengeMeta;      // from data.dailyChallenges
  potd: Task[];                  // from data.today.potd
  cp31: Task[];                  // from data.today.cp31
  onOpenTask: (sel: { id: string }) => void;
  onToggleSolved: (task: Task) => Promise<unknown>;
  onRate: (task: Task, rating: Rating) => Promise<unknown>;
  onUnrate: (task: Task) => Promise<unknown>;
  isBusy: (id: string) => boolean;
}

export default function DailyChallengesSection({
  meta,
  potd,
  cp31: cp31Tasks,
  onOpenTask,
  onToggleSolved,
  onRate,
  onUnrate,
  isBusy,
}: DailyChallengesSectionProps) {
  const toast = useUIStore((s) => s.toast);
  const { cp31OneMore, cp31Skip, cp31Retry, cp31AdvanceBand } = useDailyChallengesStore();

  const [celebrationDismissed, setCelebrationDismissed] = useState(false);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [skippedTasks, setSkippedTasks] = useState<Task[]>([]);
  const [loadingSkipped, setLoadingSkipped] = useState(false);
  const [csesPickerOpen, setCsesPickerOpen] = useState(false);

  if (!meta) return null;

  const { potd: potdMeta, cp31: cp31Meta } = meta;

  const isBandComplete = cp31Meta.bandStatus === 'complete-awaiting-confirm';
  const progressPct = cp31Meta.bandSize > 0
    ? Math.round((cp31Meta.solvedInBand / cp31Meta.bandSize) * 100)
    : 0;

  const handleOneMore = async () => {
    try {
      await cp31OneMore();
      toast('One more problem served!', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  };

  const handleSkip = async (task: Task) => {
    try {
      await cp31Skip(task.id);
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  };

  const handleRetry = async (taskId: string) => {
    try {
      await cp31Retry(taskId);
      setSkippedTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  };

  const handleAdvance = async () => {
    try {
      await cp31AdvanceBand();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  };

  const toggleSkipped = () => {
    const next = !skippedOpen;
    setSkippedOpen(next);
    if (next && skippedTasks.length === 0) {
      setLoadingSkipped(true);
      dailyChallengesApi
        .getSkipped()
        .then((tasks) => setSkippedTasks(tasks))
        .catch((err) => toast(getErrorMessage(err), 'error'))
        .finally(() => setLoadingSkipped(false));
    }
  };

  return (
    <div className="daily-challenges-container">
      {/* ── 1. POTD Section ── */}
      {potdMeta.enabled ? (
        potd.length > 0 && (
          <section className="todo-section todo-section--brand">
            <div className="todo-section__header">
              <h2 className="todo-section__title">Daily Challenge</h2>
              <span className="todo-section__count">{potd.length}</span>
            </div>
            <div className="todo-task-list">
              {potd.map((t) => (
                <TodoTaskRow
                  key={t.id}
                  task={t}
                  busy={isBusy(t.id)}
                  onOpen={onOpenTask}
                  onToggleSolved={onToggleSolved}
                  onRate={onRate}
                  onUnrate={onUnrate}
                />
              ))}
            </div>
          </section>
        )
      ) : (
        <div className="dc-off-note" style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '8px 0 16px' }}>
          LeetCode POTD is off · <Link to="/settings" style={{ color: 'var(--brand)' }}>Settings</Link>
        </div>
      )}

      {/* ── 2. CP31 Section ── */}
      {cp31Meta.enabled && cp31Meta.band && (
        <section className="cp31-section">
          {/* Header */}
          <div className="cp31-section__header">
            <div className="cp31-section__title-row">
              <span className="cp31-section__icon" aria-hidden="true">⚔️</span>
              <h2 className="cp31-section__title">CP31 · Band {cp31Meta.band}</h2>
              <span className="cp31-section__progress-text">
                {cp31Meta.solvedInBand}/{cp31Meta.bandSize}
              </span>
            </div>
            <div className="cp31-section__progress-bar">
              <div
                className="cp31-section__progress-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Band Complete Celebration */}
          {isBandComplete && !celebrationDismissed ? (
            <div className="cp31-band-complete">
              <div className="cp31-band-complete__trophy" aria-hidden="true">🏆</div>
              <h3 className="cp31-band-complete__title">
                Band {cp31Meta.band} Complete!
              </h3>
              <p className="cp31-band-complete__sub">
                {cp31Meta.solvedInBand} problems solved. Ready for the next challenge?
              </p>
              <div className="cp31-band-complete__actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleAdvance()}
                >
                  Start {cp31Meta.nextBand ? `Band ${cp31Meta.nextBand}` : 'next band'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCelebrationDismissed(true)}
                >
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Task list */}
              {cp31Tasks.length > 0 && (
                <div className="todo-task-list">
                  {cp31Tasks.map((t) => (
                    <TodoTaskRow
                      key={t.id}
                      task={t}
                      busy={isBusy(t.id)}
                      onOpen={onOpenTask}
                      onToggleSolved={onToggleSolved}
                      onRate={onRate}
                      onUnrate={onUnrate}
                      onSkip={
                        t.taskType === 'cp31' && t.status === 'pending'
                          ? handleSkip
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}

              {cp31Tasks.length === 0 && !cp31Meta.quotaDoneToday && !isBandComplete && (
                <p className="cp31-section__empty">
                  No CP31 tasks for today. All caught up!
                </p>
              )}

              {/* One More Button */}
              {cp31Meta.quotaDoneToday && !isBandComplete && (
                <div className="cp31-one-more">
                  <button
                    type="button"
                    className={`cp31-one-more__btn${cp31Meta.extrasUsedToday >= cp31Meta.extrasCap ? ' is-capped' : ''}`}
                    disabled={cp31Meta.extrasUsedToday >= cp31Meta.extrasCap}
                    onClick={() => void handleOneMore()}
                  >
                    {cp31Meta.extrasUsedToday >= cp31Meta.extrasCap
                      ? 'Great session. Come back tomorrow.'
                      : `+ One more (${cp31Meta.extrasUsedToday}/${cp31Meta.extrasCap})`}
                  </button>
                </div>
              )}

              {/* Skipped Collapsible */}
              {(cp31Meta.skippedCount ?? 0) > 0 && (
                <div className="cp31-skipped">
                  <button
                    type="button"
                    className="cp31-skipped__toggle"
                    onClick={toggleSkipped}
                  >
                    <span className="cp31-skipped__toggle-text">
                      {skippedOpen ? '▼' : '▶'} Skipped ({cp31Meta.skippedCount})
                    </span>
                  </button>
                  {skippedOpen && (
                    <div className="cp31-skipped__list">
                      {loadingSkipped ? (
                        <div className="cp31-skipped__loading">Loading…</div>
                      ) : (
                        skippedTasks.map((st) => (
                          <div key={st.id} className="cp31-skipped__row">
                            <span className="cp31-skipped__title">{st.title}</span>
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => void handleRetry(st.id)}
                            >
                              Retry
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ── 3. CSES Section ── */}
      <CsesBlock
        meta={meta.cses}
        onOpenPicker={() => setCsesPickerOpen(true)}
        onOpenTask={onOpenTask}
        onToggleSolved={onToggleSolved}
        onRate={onRate}
        onUnrate={onUnrate}
        isBusy={isBusy}
      />

      <CsesPicker
        open={csesPickerOpen}
        onClose={() => setCsesPickerOpen(false)}
      />
    </div>
  );
}
