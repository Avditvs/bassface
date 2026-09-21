/**
 * App header: brand + user badge (avatar, name, sign out).
 */

import { useState } from "react";
import { useApp } from "../services/store";
import { signOut } from "../services/session";
import { currentTheme, toggleTheme } from "../services/theme";
import { startDiscoverTour } from "../services/discover";
import { StatusBar } from "./StatusBar";

/** Small icon button that flips dark ↔ light (moon = switch to dark,
    sun = switch to light). Kept in sync via local state; the document
    attribute itself is managed by services/theme.ts. */
function ThemeToggle() {
  const [dark, setDark] = useState(currentTheme() === "dark");
  return (
    <button
      className="button button-quiet theme-toggle"
      data-tour="theme-toggle"
      type="button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => { toggleTheme(); setDark(currentTheme() === "dark"); }}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.45-.06-.9-.1-1.36-.1Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 16a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1ZM3 11h2a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Zm16 0h2a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2ZM5.64 4.22 7.05 5.64a1 1 0 1 1-1.41 1.41L4.22 5.64a1 1 0 0 1 1.42-1.42Zm11.31 11.31 1.42 1.42a1 1 0 0 1-1.42 1.42l-1.41-1.42a1 1 0 0 1 1.41-1.42Zm1.42-9.89a1 1 0 0 1 0 1.41l-1.42 1.42a1 1 0 0 1-1.41-1.42l1.41-1.41a1 1 0 0 1 1.42 0ZM6.34 15.53a1 1 0 0 1 0 1.42L4.93 18.36A1 1 0 0 1 3.51 17l1.42-1.41a1 1 0 0 1 1.41-.06Z" />
        </svg>
      )}
    </button>
  );
}

/** Bassface logo mark: blissful face on headphones with a wobble mouth.
    Single SVG with two eye variants inside — closed by default, the CSS
    crossfades the groups on .brand:hover (layout.css). One node, no
    stacking, so the mark can never overlap the brand text. */
function BrandMark() {
  return (
    <svg className="brand-logo" viewBox="12 14 104 96" width="44" height="44" aria-hidden="true">
      <defs>
        <linearGradient id="brand-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ff5500" />
        </linearGradient>
      </defs>
      <circle cx="64" cy="68" r="42" fill="#2e2e2e" />
      <path d="M20 70 C 20 40 40 22 64 22 C 88 22 108 40 108 70" fill="none" stroke="var(--text)" strokeWidth="8" strokeLinecap="round" />
      <rect x="12" y="62" width="16" height="28" rx="8" fill="url(#brand-grad)" />
      <rect x="100" y="62" width="16" height="28" rx="8" fill="url(#brand-grad)" />
      <g className="eyes-closed">
        <path d="M44 58 Q 50 52 56 58" fill="none" stroke="#f2f2f2" strokeWidth="5" strokeLinecap="round" />
        <path d="M72 58 Q 78 52 84 58" fill="none" stroke="#f2f2f2" strokeWidth="5" strokeLinecap="round" />
      </g>
      <g className="eyes-open">
        <circle cx="50" cy="55" r="6.5" fill="#f2f2f2" />
        <circle cx="78" cy="55" r="6.5" fill="#f2f2f2" />
        <circle cx="52" cy="53" r="2" fill="#1c1c1c" />
        <circle cx="80" cy="53" r="2" fill="#1c1c1c" />
      </g>
      <path d="M38 92 Q 42 84 44 84 q 5 -9 10 0 q 5 9 10 0 q 5 -9 10 0 q 5 9 10 0 Q 86 84 90 92" fill="none" stroke="url(#brand-grad)" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

export function Header() {
  const app = useApp();
  const user = app.user;
  const onPlaylist = app.route.name === "playlist";
  return (
    <header className="app-header">
      <a className="brand" href="#/playlists" aria-label="Bassface — back to playlists">
        <BrandMark />
        <h1><span className="brand-bass">Bass</span><span>face</span></h1>
      </a>
      <StatusBar />
      {user && (
        <button
          className={`button button-quiet${onPlaylist ? " discover-jump" : ""}`}
          type="button"
          title="Take a quick guided tour of the app"
          onClick={startDiscoverTour}
        >
          ✨ <span className="discover-label">Discover</span>
        </button>
      )}
      <ThemeToggle />
      {user && (
        <div className="user-area">
          {user.avatar_url && <img className="avatar" src={user.avatar_url} alt="" />}
          <span className="user-name">{user.username}</span>
          <button className="button button-quiet" type="button" onClick={signOut}>Sign out</button>
        </div>
      )}
    </header>
  );
}
