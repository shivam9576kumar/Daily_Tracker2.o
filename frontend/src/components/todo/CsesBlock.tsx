import { useDailyChallengesStore } from '../../store/dailyChallengesStore';
import TodoTaskRow from './TodoTaskRow';
import type { CsesMeta, Rating, Task } from '../../types';

interface CsesBlockProps {
  meta: CsesMeta | null | undefined;
  onOpenPicker: () => void;
  onOpenTask: (sel: { id: string }) => void;
  onToggleSolved: (task: Task) => Promise<unknown>;
  onRate: (task: Task, rating: Rating) => Promise<unknown>;
  onUnrate: (task: Task) => Promise<unknown>;
  isBusy: (id: string) => boolean;
}

export default function CsesBlock({
  meta, onOpenPicker, onOpenTask, onToggleSolved, onRate, onUnrate, isBusy,
}: CsesBlockProps) {
  const skip = useDailyChallengesStore((s) => s.csesSkip);
  const acknowledge = useDailyChallengesStore((s) => s.csesAcknowledgeReturn);

  if (!meta || meta.status === 'off') return null;

  const today = meta.problemToday;
  const position = today?.position ?? meta.returnPrompt?.position ?? null;

  return (
    <section className="cses-block card" aria-label="CSES Daily">
      <header className="cses-block__head">
        <h2 className="t-h2">CSES Daily</h2>
        <button type="button" className="t-link" onClick={onOpenPicker}>
          {meta.status === 'needs-topic' ? 'Pick a topic' : 'Topics & retry'}
        </button>
      </header>

      {meta.returnPrompt && (
        <div className="cses-block__prompt" role="status">
          <p className="t-body">
            Welcome back. You were on {meta.returnPrompt.topicTitle ?? 'a topic'}
            {meta.returnPrompt.position ? `, problem ${meta.returnPrompt.position}` : ''}.
          </p>
          <div className="cses-block__actions">
            <button type="button" className="btn-secondary btn-sm" onClick={() => void acknowledge()}>
              Continue where I left off
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => { void acknowledge(); onOpenPicker(); }}
            >
              Choose a topic
            </button>
          </div>
        </div>
      )}

      {meta.status === 'needs-topic' && (
        <p className="t-body">Pick a topic to start one problem a day.</p>
      )}

      {meta.status === 'topic-complete' && (
        <p className="t-body">Topic complete. Pick your next topic when you are ready.</p>
      )}

      {today && (
        <>
          <p className="t-meta">
            {meta.activeTopic?.title} · problem {today.position} of {today.total}
          </p>
          {today.task.status === 'pending' && !today.parked && (
            <TodoTaskRow
              task={today.task}
              busy={isBusy(today.task.id)}
              onOpen={onOpenTask}
              onToggleSolved={onToggleSolved}
              onRate={onRate}
              onUnrate={onUnrate}
            />
          )}
          {today.task.status === 'pending' && !today.parked && (
            <div className="cses-block__actions">
              <p className="t-meta">You're on problem {today.position}. Take your time.</p>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => void skip(today.task.id)}
              >
                Skip for today
              </button>
            </div>
          )}
          {meta.message === 'parked-waiting' && (
            <p className="t-body">You're on problem {position}. It continues tomorrow.</p>
          )}
        </>
      )}

      {meta.message === 'done-today' && (
        <p className="t-body">
          {meta.resolvedTodayKind === 'skipped'
            ? 'Rest day. The next problem arrives tomorrow.'
            : 'Done for today. The next one arrives tomorrow.'}
        </p>
      )}
    </section>
  );
}
