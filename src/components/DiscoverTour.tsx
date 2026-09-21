/**
 * Discover tour overlay: dims the page, cuts a spotlight hole around the
 * current step's element and shows a step card with Back / Next / Skip.
 * Rendered at the shell level; auto-starts on the first signed-in visit
 * (once — see services/discover.ts) and can be replayed from the header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../services/store";
import {
  TOUR_STEPS, discoverSeen, markDiscoverSeen, onStartDiscoverTour, stepTargetExists,
} from "../services/discover";

const CARD_WIDTH = 330;
const CARD_GAP = 14;
const SPOTLIGHT_PADDING = 6;
const VIEWPORT_MARGIN = 8;

/** Just the geometry the overlay needs from getBoundingClientRect. */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function DiscoverTour() {
  const state = useApp();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-start on first signed-in use; the header button can restart it.
  useEffect(() => {
    if (state.api && !discoverSeen()) setActive(true);
    return onStartDiscoverTour(() => setActive(true));
  }, [state.api]);

  // Only keep steps whose target element is on screen (screen-dependent).
  const steps = useMemo(
    () => (active ? TOUR_STEPS.filter((step) => stepTargetExists(step.selector)) : []),
    [active, stepIndex],
  );

  // Clamp in case the step list shrank between renders (e.g. navigation).
  const clampedIndex = Math.min(stepIndex, Math.max(0, steps.length - 1));
  const step = steps[clampedIndex];
  const isLast = clampedIndex + 1 >= steps.length;

  const finish = () => {
    markDiscoverSeen();
    setActive(false);
    setStepIndex(0);
    setRect(null);
  };

  const next = () => (isLast ? finish() : setStepIndex(clampedIndex + 1));
  const back = () => setStepIndex(Math.max(0, clampedIndex - 1));

  // Track the highlighted element: scroll it into view, then keep the
  // spotlight glued to it across scrolling and resizing.
  useEffect(() => {
    if (!active || !step) return;
    const el = document.querySelector(step.selector);
    if (!el) return;
    const measure = () => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, step]);

  // Keyboard: Esc skips, ←/→ (and Enter) navigate.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
      else if (event.key === "ArrowRight" || event.key === "Enter") next();
      else if (event.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clampedIndex, isLast]);

  // Card placement: below the spotlight when there is room, above otherwise,
  // horizontally clamped to the viewport.
  const placement = (() => {
    if (!rect) return null;
    const cardHeight = cardRef.current?.offsetHeight ?? 190;
    const below = rect.top + rect.height + CARD_GAP + cardHeight < window.innerHeight - VIEWPORT_MARGIN;
    const top = below
      ? rect.top + rect.height + CARD_GAP
      : rect.top - CARD_GAP - cardHeight;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN,
    );
    return { top, left, below };
  })();

  if (!active || !step || !rect || !placement) return null;

  return (
    <div className="discover-overlay">
      <div
        className="discover-spotlight"
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
        }}
      />
      <div
        ref={cardRef}
        className={`discover-card${placement.below ? " is-below" : " is-above"}`}
        style={{ top: placement.top, left: placement.left, width: CARD_WIDTH }}
        role="dialog"
        aria-label="Discover Bassface"
      >
        <p className="discover-step muted">Step {clampedIndex + 1} of {steps.length}</p>
        <h2 className="discover-title">{step.title}</h2>
        <p className="discover-body">{step.body}</p>
        <div className="discover-actions">
          <button className="button button-quiet" type="button" onClick={finish}>
            Skip tour
          </button>
          <span className="discover-nav">
            {clampedIndex > 0 && (
              <button className="button button-quiet" type="button" onClick={back}>
                Back
              </button>
            )}
            <button className="button button-primary" type="button" onClick={next}>
              {isLast ? "Finish" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
