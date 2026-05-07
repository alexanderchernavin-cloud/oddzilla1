// Restricts balance-mutating admin endpoints to a small allowlist of
// operator emails. Layered on top of the role=admin check so a stolen
// admin token can't drain the books — only the named operator(s) can
// move money in bettor wallets.
//
// Currently gates:
//   • POST /admin/deposits/:id/credit-manual  (credits balance)
//   • POST /admin/withdrawals/:id/mark-confirmed  (debits balance)
//   • POST /admin/tickets/:id/void  (refunds stake)
//
// Other admin endpoints (status / role / limit edits, mapping review,
// margin config, etc.) remain open to all admins; this gate is
// specifically for the wallet_ledger-writing path.

import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { users } from "@oddzilla/db";
import { ForbiddenError, UnauthorizedError } from "./errors.js";

// Hardcoded allowlist. Compared lowercase against users.email. To grant
// an additional operator, add their address here and ship a PR — the
// commit is the audit trail for who can move money.
const BALANCE_EDIT_EMAILS: ReadonlySet<string> = new Set([
  "q1qooo@gmail.com",
]);

export interface BalanceEditAdmin {
  id: string;
  email: string;
}

/**
 * Asserts the caller is signed in, has role=admin, AND their email is
 * in the balance-edit allowlist. Throws ForbiddenError otherwise so
 * the endpoint surfaces a clean 403 to the client.
 *
 * Email lookup is per-request because access JWT claims don't carry
 * email; the cost is one indexed PK SELECT per balance-edit call,
 * acceptable on these low-volume admin paths.
 */
export async function requireBalanceEditAdmin(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<BalanceEditAdmin> {
  const admin = request.requireRole("admin");
  const [row] = await app.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, admin.id))
    .limit(1);
  if (!row) throw new UnauthorizedError();
  const email = row.email.toLowerCase();
  if (!BALANCE_EDIT_EMAILS.has(email)) {
    throw new ForbiddenError(
      "balance_edit_not_authorized",
      "balance_edit_not_authorized",
    );
  }
  return { id: admin.id, email };
}
