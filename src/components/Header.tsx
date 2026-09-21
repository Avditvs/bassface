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
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.45-.06-.9-.1-1.36-.1Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 16a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1ZM3 11h2a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Zm16 0h2a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2ZM5.64 4.22 7.05 5.64a1 1 0 1 1-1.41 1.41L4.22 5.64a1 1 0 0 1 1.42-1.42Zm11.31 11.31 1.42 1.42a1 1 0 0 1-1.42 1.42l-1.41-1.42a1 1 0 0 1 1.41-1.42Zm1.42-9.89a1 1 0 0 1 0 1.41l-1.42 1.42a1 1 0 0 1-1.41-1.42l1.41-1.41a1 1 0 0 1 1.42 0ZM6.34 15.53a1 1 0 0 1 0 1.42L4.93 18.36A1 1 0 0 1 3.51 17l1.42-1.41a1 1 0 0 1 1.41-.06Z" />
        </svg>
      )}
    </button>
  );
}

export function Header() {
  const user = useApp().user;
  return (
    <header className="app-header">
      <a className="brand" href="#/playlists" aria-label="Bassface — back to playlists">
        <svg role="img" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373Zm-13.278-5.744c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0Zm-1.649 1.027c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z" />
        </svg>
        <h1>Bassface</h1>
      </a>
      <StatusBar />
      <button
        className="button button-quiet"
        type="button"
        title="Take a quick guided tour of the app"
        onClick={startDiscoverTour}
      >
        ✨ Discover
      </button>
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
