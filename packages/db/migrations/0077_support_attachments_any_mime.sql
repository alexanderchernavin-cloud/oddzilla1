-- 0077_support_attachments_any_mime.sql
--
-- Drop the MIME allowlist on support_attachments. The byte-serve route
-- (services/api/src/modules/support/routes.ts `GET /support/attachments/:id`)
-- already pins `Content-Disposition: attachment` so every download is
-- a save-to-disk action, not an inline render — that's the real defence
-- against script-bearing uploads. With the application now adding
-- `X-Content-Type-Options: nosniff` to the same response, a browser
-- can't even sniff its way back into rendering. The allowlist is
-- redundant security theatre at that point.
--
-- Operator product call: bettors and admins can attach any file format
-- on a support chat, capped only at 10 MiB per file (size_range CHECK)
-- and 5 files per message (route-level cap).

ALTER TABLE support_attachments
  DROP CONSTRAINT IF EXISTS support_attachments_mime_allowed;
