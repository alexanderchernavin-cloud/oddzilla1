-- 0076_support_attachments.sql
--
-- File attachments on live support chat messages. Each message can
-- carry up to N attachments (API-layer cap; see ATTACHMENT_MAX_PER_MSG
-- in services/api/src/modules/support/shared.ts). Per-file storage cap
-- is 10 MiB enforced at three layers: the multipart plugin's
-- fileSize stream limit (rejects oversize uploads before they hit
-- handler memory), the API-side post-stream check (handles the
-- truncated-but-no-error case), and the DB CHECK below (defence in
-- depth — a code path that bypasses the route handlers still can't
-- store a 1 GB row).
--
-- Storage is `BYTEA` in postgres, matching the established logo-upload
-- pattern (migrations 0039 / 0040 / 0041) — chat attachments are small,
-- low-volume, and never need a CDN-grade fan-out, so stuffing them in
-- the row keeps deploy + backup trivially atomic. If the volume ever
-- justifies it, swapping to S3 / object storage is a column-only
-- migration (add `external_url TEXT`, drop `data`).
--
-- Body becomes optional once attachments exist: a bettor can send "just
-- a screenshot" with no caption. The application layer (POST routes)
-- enforces "must have body OR at least one attachment"; the DB-side
-- length cap stays at 4000 but the lower bound is dropped so an empty
-- body row coexists with an attachment row created in the same tx.

-- Relax the body lower bound — keep the upper cap, drop the >= 1
-- requirement so an attachment-only message can land with an empty
-- body. App-layer still rejects messages with neither a body nor any
-- attachment, so empty rows can't slip in.
ALTER TABLE support_messages
  DROP CONSTRAINT IF EXISTS support_messages_body_length;
ALTER TABLE support_messages
  ADD CONSTRAINT support_messages_body_length
  CHECK (char_length(body) <= 4000);

CREATE TABLE support_attachments (
    id              BIGSERIAL PRIMARY KEY,
    message_id      BIGINT NOT NULL
                    REFERENCES support_messages(id) ON DELETE CASCADE,
    -- Sanitised display name. The API strips path separators and
    -- caps to 255 chars before insert; this CHECK is the DB-side
    -- safety net.
    filename        TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    data            BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT support_attachments_filename_length
        CHECK (char_length(filename) BETWEEN 1 AND 255),
    CONSTRAINT support_attachments_size_range
        -- 10 MiB cap. Mirrors the API constant MAX_ATTACHMENT_BYTES.
        -- Zero-byte uploads are rejected at the route too (file_empty);
        -- this CHECK rejects them at the DB layer for belt + braces.
        CHECK (size_bytes > 0 AND size_bytes <= 10485760),
    -- MIME allowlist. Intentionally NO image/svg+xml — SVG can carry
    -- inline <script> and we'd be serving it back to other users, so
    -- it's outside the safe set for user-generated content. Text/plain
    -- covers log paste-as-file; pdf for receipts / screenshots; the
    -- raster formats cover phone screenshots.
    CONSTRAINT support_attachments_mime_allowed
        CHECK (content_type IN (
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
            'application/pdf',
            'text/plain'
        ))
);

-- Per-message join lookup powering both the bettor /support/me/thread
-- read and the admin thread detail page.
CREATE INDEX support_attachments_message_idx
    ON support_attachments (message_id);
