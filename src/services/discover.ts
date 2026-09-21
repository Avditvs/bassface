/**
 * Discover tour: a first-use guided walkthrough of the app's key features.
 * Each step highlights an on-screen element (found by CSS selector) with a
 * spotlight; the user advances with "Next", can skip at any point, and can
 * replay the tour from the header button.
 *
 * The tour auto-starts once (flag in localStorage, see markDiscoverSeen);
 * steps whose target element is not on screen (screen-dependent features)
 * are skipped automatically — unless the step declares a `prepare` action
 * that can bring its target back (e.g. un-retract the sidebar panel).
 */

const DISCOVER_KEY = "playlist_updater.discover";
const RESTART_EVENT = "bassface:discover-start";

import { getState } from "./store";
import { navigateToPlaylist } from "./router";
import { expandSidebarPanel } from "./organize";

/** One tour stop: what to highlight and what to say about it. */
export interface TourStep {
  /** CSS selector of the element to spotlight; missing elements skip the step. */
  selector: string;
  title: string;
  body: string;
  /** Optional side effect fired when the user advances past this step —
   *  e.g. navigate to the screen the next steps talk about. */
  advance?: () => void;
  /** Optional action fired once when the target is missing, before the step
   *  is skipped — e.g. expand a retracted panel so its search bar shows up. */
  prepare?: () => void;
}

/** The tour, in visiting order. Screen-specific targets (analyze, sidebar)
 *  only match on the playlist detail screen and vanish elsewhere. */
export const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="playlists-search"]',
    title: "Find any playlist fast",
    body: "Type here to filter your playlists by title. The dropdowns next to it pick a playlist type and a sort order.",
  },
  {
    selector: '[data-tour="liked-button"]',
    title: "Your liked tracks",
    body: "Every track you ever hearted on SoundCloud, most recently liked first — the raw material for building new playlists.",
  },
  {
    selector: '[data-tour="playlist-grid"]',
    title: "All your playlists",
    body: "Each card opens the full track list. Badges show sharing status and playlist type at a glance — let's open your first one.",
    // The next steps live on the detail screen: open the first playlist.
    advance: () => {
      const first = getState().playlists[0];
      if (first) navigateToPlaylist(first.id);
    },
  },
  {
    selector: '[data-tour="analyze-all"]',
    title: "Keys & tempo in one click",
    body: "Inside a playlist, “Analyze all” estimates the BPM and musical key of every track — perfect for planning a smooth DJ set.",
  },
  {
    selector: '[data-tour="remove-zone"]',
    title: "Take tracks out",
    body: "Drag a sound onto this bin — or swipe it left on a touchscreen — to remove it from the open playlist. Every action can be reverted.",
  },
  {
    selector: '[data-tour="organize-sidebar"]',
    title: "Reorganize by drag & drop",
    body: "Drag any sound onto another playlist to copy it there, or onto its right-hand strip to move it out of the open playlist.",
  },
  {
    selector: '[data-tour="organize-filter"]',
    title: "Find the right playlist fast",
    body: "Many playlists? Type here to filter the sidebar list — drag targets update instantly.",
    // The search bar can be retracted ("Retract" toggle): bring it back
    // instead of skipping the step.
    prepare: expandSidebarPanel,
  },
  {
    selector: '[data-tour="organize-toggle"]',
    title: "Retract or expand the panel",
    body: "Short on space? “Retract” hides the search bar and description; “Expand” brings them back — your choice is remembered.",
  },
  {
    selector: '[data-tour="theme-toggle"]',
    title: "Light or dark",
    body: "Switch the theme any time — your choice is remembered for the next visit.",
  },
];

/** True once the user has seen (or skipped) the tour. Defaults to "seen"
 *  when storage is blocked, so nobody is trapped in a recurring tour. */
export function discoverSeen(): boolean {
  try {
    return localStorage.getItem(DISCOVER_KEY) === "1";
  } catch {
    return true;
  }
}

/** Mark the tour as seen — called on skip and on finish. */
export function markDiscoverSeen(): void {
  try {
    localStorage.setItem(DISCOVER_KEY, "1");
  } catch {
    // Storage blocked: the tour may reappear next visit. Not fatal.
  }
}

/** True while the element a step points at is currently in the DOM. */
export function stepTargetExists(selector: string): boolean {
  return Boolean(document.querySelector(selector));
}

/** Restart the tour (header "Discover" button). */
export function startDiscoverTour(): void {
  window.dispatchEvent(new Event(RESTART_EVENT));
}

/** Subscribe to tour restarts; returns an unsubscribe function. */
export function onStartDiscoverTour(listener: () => void): () => void {
  window.addEventListener(RESTART_EVENT, listener);
  return () => window.removeEventListener(RESTART_EVENT, listener);
}
