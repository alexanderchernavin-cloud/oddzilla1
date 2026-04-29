// smoke-settle is a one-shot CLI that settles a single ticket by id.
// Used by the placement→settlement smoke harness in .scratch/pg-smoke
// to exercise settler.maybeSettleTicket against a live test DB without
// running the full AMQP consumer.
//
// Usage:  smoke-settle <ticket-id>
// Env:    DATABASE_URL  (required)
//
// Behavior:
//   - Opens a tx
//   - Loads the ticket FOR UPDATE
//   - Loads its resolved selections (caller must have set result/void_factor)
//   - Calls settler.computePayout via the same dispatcher production uses
//   - Calls store.SettleTicket which updates wallet + inserts ledger row
//   - Commits and prints (payout_micro, ledger_type)
//
// On any error it prints to stderr and exits non-zero.

package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"github.com/oddzilla/settlement/internal/settler"
	"github.com/oddzilla/settlement/internal/store"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: smoke-settle <ticket-id>")
		os.Exit(2)
	}
	ticketID := os.Args[1]
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL required")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fail("connect: %v", err)
	}
	defer pool.Close()

	st := store.New(pool)
	log := zerolog.Nop()
	_ = settler.New(st, nil, 100, log) // future: drive via Settler.Handle

	tx, err := pool.Begin(ctx)
	if err != nil {
		fail("begin: %v", err)
	}
	defer tx.Rollback(ctx)

	t, locked, err := store.LoadTicketForSettle(ctx, tx, ticketID)
	if err != nil {
		fail("load ticket: %v", err)
	}
	if !locked {
		fail("ticket %s not found / locked by another", ticketID)
	}
	if t.Status != "accepted" {
		fail("ticket %s status=%s, expected accepted", ticketID, t.Status)
	}
	unresolved, err := store.UnresolvedCount(ctx, tx, ticketID)
	if err != nil {
		fail("unresolved count: %v", err)
	}
	if unresolved > 0 {
		fail("ticket %s has %d unresolved selection(s) — set ticket_selections.result first", ticketID, unresolved)
	}
	selections, err := store.ResolvedSelections(ctx, tx, ticketID)
	if err != nil {
		fail("resolved selections: %v", err)
	}

	payout, ledgerType, err := settler.ComputePayoutForSmoke(t, selections)
	if err != nil {
		fail("compute payout: %v", err)
	}
	if err := store.SettleTicket(ctx, tx, t, payout, ledgerType, "smoke"); err != nil {
		fail("settle ticket: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		fail("commit: %v", err)
	}
	fmt.Printf("%s payout=%d ledger=%s bet_type=%s\n", ticketID, payout, ledgerType, t.BetType)
}

func fail(format string, args ...any) {
	fmt.Fprintln(os.Stderr, fmt.Errorf(format, args...))
	os.Exit(1)
}
