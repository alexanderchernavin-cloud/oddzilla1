// Tiny wrapper for read-only git invocations from the admin/deploy
// route. Centralised here so the spawn pattern (array-form, no shell)
// is in one auditable place.
//
// Security notes:
//   • We use `spawn` with an array of args, never `exec`. Args are
//     never shell-interpreted; no quoting or escaping concerns.
//   • Every caller is server-side and the arg list is constructed
//     from constants + hex SHAs we re-validated (/^[0-9a-f]{40}$/)
//     before passing in. No user input ever reaches this function.
//   • `--git-dir=…` is set as the first arg so callers don't have to
//     repeat it. The path is configured via DEPLOY_GIT_DIR and
//     resolved at boot; it points at the bind-mounted .git/ dir
//     inside the api container.

import { spawn } from "node:child_process";

const GIT_DIR = process.env.DEPLOY_GIT_DIR ?? "/srv/repo-git";

export function runGitNoShell(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", [`--git-dir=${GIT_DIR}`, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`),
        );
    });
  });
}
