// Firebase Admin SDK lazy initializer.
//
// Service-account credential lookup order:
//   1. FIREBASE_SERVICE_ACCOUNT_PATH — explicit path to the JSON file.
//   2. GOOGLE_APPLICATION_CREDENTIALS — the SDK's standard env var, same
//      JSON shape. Set this in compose when mounting the service-account
//      file into a fixed in-container path.
//
// When neither is set the module exposes `isFirebaseEnabled() === false`
// and the outbox worker marks pending rows as `firebase_disabled` so the
// queue drains naturally. Flipping the env var on later restarts the
// api and future settlements push for real.
//
// We keep this as a thin singleton wrapper so the worker module can be
// imported in environments where firebase-admin isn't installed (e.g.
// the ws-gateway) without pulling the SDK in transitively.

import { existsSync, readFileSync } from "node:fs";
import type { App } from "firebase-admin/app";
import type { Messaging } from "firebase-admin/messaging";

let cachedApp: App | null = null;
let initialized = false;
let initError: string | null = null;

function credentialPath(): string | null {
  const explicit = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const fallback = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fallback && fallback.trim().length > 0) return fallback.trim();
  return null;
}

// "Enabled" means the credential is configured AND the file is
// actually on disk. Earlier this only checked the env var, which
// produced a misleading `firebase=enabled` boot log when the path
// was set but the file was never dropped into the bind mount. The
// worker then committed every push with last_error=firebase_init_failed.
// Logging the resolved state at boot avoids that silent failure mode.
export function isFirebaseEnabled(): boolean {
  const path = credentialPath();
  if (!path) return false;
  return existsSync(path);
}

export function firebaseCredentialPath(): string | null {
  return credentialPath();
}

export function firebaseInitError(): string | null {
  return initError;
}

// initFirebase reads + parses the service-account JSON at boot. We avoid
// the SDK's auto-detect path because it returns a vague error on a
// malformed file; reading explicitly lets us surface a clear log line.
export async function getFirebaseApp(): Promise<App | null> {
  if (initialized) return cachedApp;
  initialized = true;
  const path = credentialPath();
  if (!path) return null;

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !parsed.project_id) {
      throw new Error("service-account JSON missing project_id");
    }
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    // initializeApp() throws if called twice with the same name; in dev
    // this module can be re-imported by tsx --watch, so reuse any
    // existing default app.
    const existing = getApps();
    if (existing.length > 0) {
      cachedApp = existing[0]!;
      return cachedApp;
    }
    cachedApp = initializeApp({
      credential: cert(parsed),
    });
    return cachedApp;
  } catch (err) {
    initError = (err as Error).message;
    cachedApp = null;
    return null;
  }
}

export async function getMessaging(): Promise<Messaging | null> {
  const app = await getFirebaseApp();
  if (!app) return null;
  const { getMessaging: get } = await import("firebase-admin/messaging");
  return get(app);
}
