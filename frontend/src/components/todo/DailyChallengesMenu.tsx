import { useEffect, useRef, useState } from 'react';
import { useDailyChallengesStore } from '../../store/dailyChallengesStore';
import BandPickerModal from './BandPickerModal';
import CsesPicker from './CsesPicker';
import './todo.css';

export default function DailyChallengesMenu() {
  const [open, setOpen] = useState(false);
  const [bandPickerOpen, setBandPickerOpen] = useState(false);
  const [csesPickerOpen, setCsesPickerOpen] = useState(false);
  const [resumeBand, setResumeBand] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const {
    settings, loading, saving, error,
    fetch, setPotdEnabled, disableCp31, setCp31DailyCount,
    cses, csesSetEnabled, csesRefresh,
  } = useDailyChallengesStore();

  useEffect(() => {
    if (open && !settings && !loading) void fetch();
    if (open && !cses) void csesRefresh(true);
  }, [open, settings, loading, fetch, cses, csesRefresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const potdOn = settings?.potdEnabled ?? true;
  const cp31On = settings?.cp31Enabled ?? false;
  const cp31Band = settings?.cp31Band ?? null;
  const cp31DailyCount = settings?.cp31DailyCount ?? 1;
  const csesOn = cses?.enabled ?? false;
  const csesTopic = cses?.activeTopic?.title ?? null;

  const handleCsesToggle = () => {
    if (csesOn) {
      void csesSetEnabled(false);
    } else {
      void csesSetEnabled(true);
      if (cses?.status === 'needs-topic' || !cses?.activeTopic) {
        setCsesPickerOpen(true);
        setOpen(false);
      }
    }
  };

  const handleCp31Toggle = () => {
    if (cp31On) {
      // Turning off
      void disableCp31();
    } else {
      // Turning on
      if (cp31Band) {
        // Previously had a band → show resume dialog
        setResumeBand(cp31Band);
        setBandPickerOpen(true);
      } else {
        // First time → show band picker
        setResumeBand(null);
        setBandPickerOpen(true);
      }
      setOpen(false); // close the menu so modal is visible
    }
  };

  return (
    <>
      <div className="dc-menu" ref={ref}>
        <button
          type="button"
          className="btn-secondary btn-sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Daily challenges"
          onClick={() => setOpen((o) => !o)}
        >
          ⚡ Daily
        </button>

        {open && (
          <div className="dc-menu__panel" role="dialog" aria-label="Daily challenges">
            <div className="dc-menu__title">
              Daily challenges
              {saving && <span className="spinner" aria-label="Saving" style={{ width: 14, height: 14, marginLeft: 8, display: 'inline-block' }} />}
            </div>

            {/* POTD row */}
            <div className="dc-row">
              <div className="dc-row__text">
                <span className="dc-row__name">LeetCode POTD</span>
                <span className="dc-row__desc">
                  {potdOn ? 'One LeetCode problem a day, added to Today.' : 'Off — today\u2019s challenge is hidden.'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={potdOn}
                aria-label="Toggle LeetCode POTD"
                className={`dc-switch${potdOn ? ' is-on' : ''}`}
                disabled={loading}
                onClick={() => void setPotdEnabled(!potdOn)}
              >
                <span className="dc-switch__thumb" aria-hidden="true" />
              </button>
            </div>

            {/* CP31 row */}
            <div className="dc-row">
              <div className="dc-row__text">
                <span className="dc-row__name">
                  Codeforces CP31
                  {cp31On && cp31Band && (
                    <button
                      type="button"
                      className="dc-row__band-chip"
                      onClick={() => { setResumeBand(null); setBandPickerOpen(true); setOpen(false); }}
                      title="Click to change band"
                    >
                      Band {cp31Band} · Change
                    </button>
                  )}
                </span>
                <span className="dc-row__desc">
                  {cp31On
                    ? `Solving Band ${cp31Band} — ${cp31DailyCount}/day`
                    : 'Off — 31-problem rating ladders from Codeforces.'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={cp31On}
                aria-label="Toggle Codeforces CP31"
                className={`dc-switch${cp31On ? ' is-on' : ''}`}
                disabled={loading}
                onClick={handleCp31Toggle}
              >
                <span className="dc-switch__thumb" aria-hidden="true" />
              </button>
            </div>

            {/* Daily Count Stepper (when CP31 enabled) */}
            {cp31On && (
              <div className="dc-stepper">
                <span className="dc-stepper__label">Daily problems:</span>
                <div className="dc-stepper__controls">
                  <button
                    type="button"
                    className="dc-stepper__btn"
                    disabled={loading || cp31DailyCount <= 1}
                    onClick={() => void setCp31DailyCount(Math.max(1, cp31DailyCount - 1))}
                    aria-label="Decrease daily count"
                  >
                    −
                  </button>
                  <span className="dc-stepper__value">{cp31DailyCount}</span>
                  <button
                    type="button"
                    className="dc-stepper__btn"
                    disabled={loading || cp31DailyCount >= 3}
                    onClick={() => void setCp31DailyCount(Math.min(3, cp31DailyCount + 1))}
                    aria-label="Increase daily count"
                  >
                    +
                  </button>
                </div>
              </div>
            )}

            {/* CSES row */}
            <div className="dc-row">
              <div className="dc-row__text">
                <span className="dc-row__name">
                  CSES Daily
                  {csesOn && csesTopic && (
                    <button
                      type="button"
                      className="dc-row__band-chip"
                      onClick={() => { setCsesPickerOpen(true); setOpen(false); }}
                      title="Click to view topics"
                    >
                      {csesTopic} · Topics
                    </button>
                  )}
                </span>
                <span className="dc-row__desc">
                  {csesOn
                    ? (csesTopic ? `Topic: ${csesTopic} — 1/day` : 'Pick a topic to start')
                    : 'Off — one CSES problem a day, topic-based.'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={csesOn}
                aria-label="Toggle CSES Daily"
                className={`dc-switch${csesOn ? ' is-on' : ''}`}
                disabled={loading}
                onClick={handleCsesToggle}
              >
                <span className="dc-switch__thumb" aria-hidden="true" />
              </button>
            </div>

            {error && <p className="dc-menu__error">{error}</p>}
            <p className="dc-menu__note">
              Turning off removes today's pending challenges. Solved history, coins and streak are kept.
            </p>
          </div>
        )}
      </div>

      <BandPickerModal
        open={bandPickerOpen}
        onClose={() => setBandPickerOpen(false)}
        resumeBand={resumeBand}
      />

      <CsesPicker
        open={csesPickerOpen}
        onClose={() => setCsesPickerOpen(false)}
      />
    </>
  );
}
