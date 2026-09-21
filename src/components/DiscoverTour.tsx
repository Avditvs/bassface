/**
 * Discover tour overlay: dims the page, cuts a spotlight hole around the
 * current step's element and shows a step card with Back / Next / Skip.
 * Rendered at the shell level; auto-starts on the first signed-in visit
 * (once — see services/discover.ts) and can be replayed from the header.
 */

import { useEffect, useRef, useState } from "react";
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
  // Start at the first step whose target exists (a reload can land on any
  // screen; the grid steps only exist on the playlists screen).
  useEffect(() => {
    if (state.api && !discoverSeen()) {
      setActive(true);
      setStepIndex(Math.max(0, TOUR_STEPS.findIndex((s) => stepTargetExists(s.selector))));
    }
    return onStartDiscoverTour(() => setActive(true));
  }, [state.api]);

  // The full tour; steps whose target is missing are skipped on the fly
  // (see the measurement effect below), never filtered at render time — the
  // DOM may still show the previous screen right after a navigation.
  const steps = active ? TOUR_STEPS : [];

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

  const next = () => {
    if (isLast) {
      finish();
      return;
    }
    // Optional step action (e.g. open the first playlist) before advancing.
    step.advance?.();
    setStepIndex(clampedIndex + 1);
    setRect(null); // previous spotlight must not linger mid-navigation
  };
  const back = () => setStepIndex(Math.max(0, clampedIndex - 1));

  // Track the highlighted element: scroll it into view once, then keep the
  // spotlight glued to it across scrolling and resizing (measuring only —
  // scrolling on every scroll event would fight the user). A freshly
  // advanced step's target may not be mounted yet (navigation is async) —
  // retry briefly, then — after firing the step's `prepare`, if any — skip
  // the step entirely if it never shows up.
  useEffect(() => {
    if (!active || !step) return;
    let attempts = 0;
    let scrolled = false;
    let prepared = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const target = document.querySelector(step.selector);
      if (!target) {
        setRect(null);
        // The element may be hidden rather than absent: a `prepare` action
        // (e.g. expand the retracted sidebar panel) is fired once, then the
        // retry window below gives it time to appear.
        if (!prepared) {
          prepared = true;
          step.prepare?.();
        }
        // The element may still be mounting (e.g. right after the step's
        // advance() navigated to another screen) — retry ~1.5 s, then skip.
        if (attempts++ < 15) timer = setTimeout(measure, 100);
        else if (clampedIndex + 1 < steps.length) setStepIndex(clampedIndex + 1);
        else finish();
        return;
      }
      if (!scrolled) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        scrolled = true;
      }
      const r = target.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, step, clampedIndex]);

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

  // Card placement, driven by the *visible* part of the target (an element
  // can be taller than the viewport or scrolled halfway out of it): below
  // the spotlight when there is room, above otherwise, always clamped —
  // top, left and width — so the card never leaves the screen.
  const placement = (() => {
    if (!rect) return null;
    const cardHeight = cardRef.current?.offsetHeight ?? 190;
    const cardWidth = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const visibleTop = Math.max(rect.top, VIEWPORT_MARGIN);
    const visibleBottom = Math.min(rect.top + rect.height, window.innerHeight - VIEWPORT_MARGIN);
    const below = window.innerHeight - VIEWPORT_MARGIN - visibleBottom >= cardHeight + CARD_GAP;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, below ? visibleBottom + CARD_GAP : visibleTop - CARD_GAP - cardHeight),
      window.innerHeight - VIEWPORT_MARGIN - cardHeight,
    );
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      window.innerWidth - cardWidth - VIEWPORT_MARGIN,
    );
    return { top, left, width: cardWidth, below };
  })();

  // Spotlight clamped to the viewport: a target taller/wider than the
  // screen (the playlist grid) must not push the hole offscreen.
  const spotlight = (() => {
    if (!rect) return null;
    const top = Math.max(rect.top - SPOTLIGHT_PADDING, 0);
    const left = Math.max(rect.left - SPOTLIGHT_PADDING, 0);
    return {
      top,
      left,
      width: Math.min(rect.width + SPOTLIGHT_PADDING * 2, window.innerWidth - left),
      height: Math.min(rect.height + SPOTLIGHT_PADDING * 2, window.innerHeight - top),
    };
  })();

  if (!active || !step || !rect || !placement || !spotlight) return null;

  return (
    <div className="discover-overlay">
      <div
        className="discover-spotlight"
        style={{
          top: spotlight.top,
          left: spotlight.left,
          width: spotlight.width,
          height: spotlight.height,
        }}
      />
      <div
        ref={cardRef}
        className={`discover-card${placement.below ? " is-below" : " is-above"}`}
        style={{ top: placement.top, left: placement.left, width: placement.width }}
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
