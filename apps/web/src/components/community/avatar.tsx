import Image from "next/image";

// Single avatar visual primitive used across community surfaces:
// feed cards, profile hero, picker grid, topbar (future). Fallback
// is a monogram of the first character of the nickname/name on the
// elevated bg, which keeps the chrome present even when a user has
// no equipped avatar yet.
//
// imageUrl resolution lives server-side (resolveAvatarUrl) so this
// component never decides between static-path vs upload-byte modes —
// it just renders whatever URL came down.

interface AvatarProps {
  imageUrl: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  className?: string;
  // Pass priority for above-the-fold avatars (the profile hero).
  priority?: boolean;
}

export function Avatar({
  imageUrl,
  name,
  size = 40,
  className = "",
  priority = false,
}: AvatarProps) {
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  const sharedStyle = {
    width: size,
    height: size,
  };
  const wrapperCls =
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] " +
    className;

  if (!imageUrl) {
    return (
      <span
        aria-hidden
        className={wrapperCls + " font-mono text-[var(--color-fg-muted)]"}
        style={{ ...sharedStyle, fontSize: Math.max(10, Math.floor(size / 2.4)) }}
      >
        {initial}
      </span>
    );
  }
  // unoptimized for /api/community/avatars/* (BYTEA upload path) —
  // Next.js's image optimizer can't introspect dynamic API responses.
  // Static /avatars/*.png keeps full optimization.
  const unoptimized = imageUrl.startsWith("/api/");
  return (
    <span
      className={wrapperCls}
      style={sharedStyle}
      role="img"
      aria-label={name ? `${name}'s avatar` : "User avatar"}
    >
      <Image
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        sizes={`${size}px`}
        unoptimized={unoptimized}
        priority={priority}
        className="h-full w-full object-cover"
      />
    </span>
  );
}
