"use client";

import { useState } from "react";

/**
 * A square logo, or nothing.
 *
 * Draws the picture when there is one and NOTHING when there isn't —
 * including when the `<img>` errors out, which is why this is a client
 * component: a server-rendered `<img>` cannot hide itself, and a broken
 * image icon is worse than an empty slot. Deliberately no monogram or
 * initials stand-in, the same call `TeamMark` and the sidebar's
 * `TournamentLogoMark` make: an invented mark abbreviating words already
 * on the row reads as a badge that means something.
 *
 * Tournament logo URLs come from several sources (our own byte-serve,
 * Fonbet's CDN, Wikimedia), so URL rot is a normal state, not an
 * exception.
 */
export function LogoMark({
  logoUrl,
  name,
  size = 16,
}: {
  logoUrl?: string | null;
  name?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  if (!logoUrl || errored) return null;
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden
      width={size}
      height={size}
      title={name}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
    />
  );
}
