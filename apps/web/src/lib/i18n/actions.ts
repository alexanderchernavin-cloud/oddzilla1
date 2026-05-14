"use server";

// Server action invoked by the language switcher. Writes the locale
// cookie and returns — the form on the client re-fetches the page so
// the SSR layout picks the new locale up via `getServerLocale()`.
//
// Cookie is set with `Domain=.oddzilla.cc` (same as the auth cookies)
// so picking a language on the apex storefront applies on the admin
// subdomain too. Locally the domain attr is dropped — browsers treat
// undefined Domain as host-only, which is exactly what we want for dev.

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "./config";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function setLocaleAction(formData: FormData): Promise<void> {
  const candidate = formData.get("locale");
  if (typeof candidate !== "string" || !isLocale(candidate)) {
    // Quietly ignore — the client only submits values from the shipped
    // list, so this branch indicates either tampering or a stale tab
    // after a locale was removed. Either way, no-op is safer than
    // throwing into a navigation handler.
    return;
  }
  const cookieStore = await cookies();
  const cookieDomain = process.env.COOKIE_DOMAIN;
  cookieStore.set({
    name: LOCALE_COOKIE,
    value: candidate,
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    ...(cookieDomain && cookieDomain.length > 0 ? { domain: cookieDomain } : {}),
  });
}
