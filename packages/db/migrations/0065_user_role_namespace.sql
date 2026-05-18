-- 0065_user_role_namespace.sql
--
-- Same email, two distinct entities. Until this migration the (email)
-- tuple was globally unique on `users`, so operators with both a bettor
-- and an admin identity had to use a different email per account — by
-- convention a Gmail-style "+admin" suffix (`q1qooo+admin@gmail.com`
-- alongside `q1qooo@gmail.com`).
--
-- Replace the global unique with TWO partial unique indexes keyed by
-- the same column-derived namespace already encoded in `users.role`:
--
--   * `role = 'user'`               → bettor namespace (oddzilla.cc)
--   * `role IN ('admin','support')` → admin namespace  (sadmin.oddzilla.cc)
--
-- Each namespace stays uniquely keyed by email; one email may now own
-- one row in each namespace. The auth layer (services/api/src/modules/
-- auth) reads the request host on every /auth/login call and filters by
-- the matching namespace, so the subdomain implicitly tells the lookup
-- which account to authenticate. No new column needed — the role
-- discriminator already carries the information.
--
-- The migration also strips the legacy `+admin@` suffix from every
-- existing admin/support row so the new model's clean email becomes the
-- canonical login. A pre-flight check (see PR description) confirmed
-- zero in-namespace collisions on the renames. Bettor rows are
-- untouched; existing `<local>@<host>` bettor accounts coexist with
-- newly-renamed `<local>@<host>` admin accounts under the partial
-- unique indexes.

BEGIN;

-- The two partial unique indexes are tighter subsets of the existing
-- global unique, so they slot in without conflict while the global
-- constraint is still active. Built BEFORE the drop so a concurrent
-- INSERT racing the migration always sees at least one of the unique
-- guarantees in place.
CREATE UNIQUE INDEX users_email_bettor_uniq
  ON users (email)
  WHERE role = 'user';

CREATE UNIQUE INDEX users_email_admin_uniq
  ON users (email)
  WHERE role IN ('admin', 'support');

-- Drop the global unique; the partial indexes above now cover every row.
ALTER TABLE users DROP CONSTRAINT users_email_key;

-- Strip the `+admin` suffix from admin/support emails. Cast to text
-- because citext doesn't expose `~` / `regexp_replace` overloads
-- directly. Idempotent under replay: rows already missing the suffix
-- (e.g. `admin@oddzilla.local`) don't match the WHERE predicate.
UPDATE users
   SET email = regexp_replace(email::text, '\+admin@', '@')
 WHERE role IN ('admin', 'support')
   AND email::text ~ '\+admin@';

COMMIT;
