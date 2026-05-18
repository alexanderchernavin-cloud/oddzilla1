// Fetches human-readable match + market + outcome labels for a ticket,
// for use in the push-notification body. Called from worker.ts at
// dispatch time so the producer (services/settlement) doesn't have to
// know about description templates or pay the join cost per settle.
//
// Best-effort by design: a missing description template falls back to
// "Market #N" / "Outcome <id>"; a missing competitor profile leaves
// URN-shaped specifiers as-is. The notification still ships with the
// money + win signal — labels are the cherry on top.

import type { SqlClient } from "@oddzilla/db";
import { substituteTemplate, renderOutcomeLabel } from "../../lib/market-naming.js";

export interface SelectionLabel {
  homeTeam: string;
  awayTeam: string;
  marketName: string;
  outcomeName: string;
}

interface RawRow {
  home_name: string | null;
  away_name: string | null;
  provider_market_id: number;
  outcome_id: string;
  specifiers_json: Record<string, string> | null;
  market_template: string | null;
  outcome_template: string | null;
}

const MAX_SELECTIONS = 5;

export async function loadTicketLabels(
  sql: SqlClient,
  ticketId: string,
): Promise<SelectionLabel[]> {
  // Deterministic order by markets.id so a combo's "first leg" is stable
  // across re-quotes. Variant + language pinned to '' / 'en' — the push
  // body is English-only for now; localised pushes can pick up the
  // bettor's preferred language from `users` later.
  const rows = await sql<RawRow[]>`
    SELECT
      ch.name                 AS home_name,
      ca.name                 AS away_name,
      m.provider_market_id    AS provider_market_id,
      ts.outcome_id           AS outcome_id,
      m.specifiers_json       AS specifiers_json,
      md.name_template        AS market_template,
      od.name_template        AS outcome_template
    FROM ticket_selections ts
    JOIN markets    m  ON m.id = ts.market_id
    JOIN matches    mt ON mt.id = m.match_id
    LEFT JOIN competitors ch ON ch.id = mt.home_competitor_id
    LEFT JOIN competitors ca ON ca.id = mt.away_competitor_id
    LEFT JOIN market_descriptions md
      ON md.provider_market_id = m.provider_market_id
     AND md.variant = ''
     AND md.language = 'en'
    LEFT JOIN outcome_descriptions od
      ON od.provider_market_id = m.provider_market_id
     AND od.outcome_id = ts.outcome_id
     AND od.variant = ''
     AND od.language = 'en'
    WHERE ts.ticket_id = ${ticketId}::uuid
    ORDER BY m.id
    LIMIT ${MAX_SELECTIONS}
  `;
  return rows.map((r) => buildLabel(r));
}

function buildLabel(r: RawRow): SelectionLabel {
  const home = r.home_name ?? "?";
  const away = r.away_name ?? "?";
  const specs: Record<string, string> = r.specifiers_json ?? {};
  const marketName = r.market_template
    ? substituteTemplate(r.market_template, specs, { homeTeam: home, awayTeam: away })
    : `Market #${r.provider_market_id}`;
  const outcomeName = r.outcome_template
    ? renderOutcomeLabel(r.outcome_template, specs, home, away)
    : r.outcome_id;
  return { homeTeam: home, awayTeam: away, marketName, outcomeName };
}
