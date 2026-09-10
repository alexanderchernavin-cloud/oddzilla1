package store

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// These tests pin the SHAPE of the money SQL without a database: the
// clauses that make settlement idempotent and currency-scoped are the
// ones a refactor is most likely to drop silently.

func TestLedgerInsertIsApplyOnce(t *testing.T) {
	if !strings.Contains(sqlInsertLedger, "ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING") {
		t.Error("ledger insert must ride the wallet_ledger unique partial index")
	}
	if !strings.Contains(sqlInsertLedger, "::wallet_tx_type") {
		t.Error("ledger type must be cast to the enum")
	}
}

func TestWalletStatementsAreCurrencyScoped(t *testing.T) {
	for name, sql := range map[string]string{"settle": sqlReleaseStakeOnSettle, "void": sqlReleaseStakeOnVoid} {
		if !strings.Contains(sql, "WHERE user_id = $1 AND currency = $2") {
			t.Errorf("%s wallet update must be scoped by (user_id, currency)", name)
		}
	}
	if !strings.Contains(sqlReleaseStakeOnSettle, "balance_micro = balance_micro + ($4 - $3)") {
		t.Error("settle must move the balance by payout - stake")
	}
	if strings.Contains(sqlReleaseStakeOnVoid, "balance_micro") {
		t.Error("void must leave the balance unchanged")
	}
	if !strings.Contains(sqlOpenSpins, "TRIM(currency)") {
		t.Error("open spins must trim the CHAR(4) currency")
	}
}

func TestSpinRowUpdatesAreGuardedOnOpen(t *testing.T) {
	for name, sql := range map[string]string{"settle": sqlSettleSpin, "void": sqlVoidSpin} {
		if !strings.Contains(sql, "WHERE id = $1 AND status = 'open'") {
			t.Errorf("%s must only touch an open spin", name)
		}
	}
}

func TestOpenLiabilityReleaseIsUSDCOnly(t *testing.T) {
	if !strings.Contains(sqlReleaseOpenLiability, "GREATEST(0, open_liability_micro - $1::bigint)") {
		t.Error("open liability must floor at zero")
	}
	rec := &recorder{}
	ctx := context.Background()
	for _, cur := range []string{"OZ", "OZ  ", "usdc", ""} {
		if err := releaseOpenLiability(ctx, rec, cur, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if err := releaseOpenLiability(ctx, rec, "USDC", 0); err != nil {
		t.Fatal(err)
	}
	if len(rec.calls) != 0 {
		t.Errorf("non-USDC / zero exposure must not touch the bank: %d calls", len(rec.calls))
	}
	if err := releaseOpenLiability(ctx, rec, "USDC", 1000); err != nil {
		t.Fatal(err)
	}
	if err := releaseOpenLiability(ctx, rec, "USDC ", 500); err != nil {
		t.Fatal(err)
	}
	if len(rec.calls) != 2 || rec.calls[0] != sqlReleaseOpenLiability {
		t.Errorf("USDC (padded or not) must release: %d calls", len(rec.calls))
	}
}

func TestGameTotalsRouteByCurrency(t *testing.T) {
	for name, sql := range map[string]string{"payout": sqlAddGamePayout, "stake": sqlSubtractGameStake} {
		if !strings.Contains(sql, "CASE WHEN $2 = 'USDC'") || !strings.Contains(sql, "CASE WHEN $2 = 'OZ'") {
			t.Errorf("%s total must branch on currency", name)
		}
	}
}

func TestCandidatesAreConfirmedBasketball(t *testing.T) {
	for _, clause := range []string{"msr.status = 'confirmed'", "msr.sr_sport_id = 2", "m.status IN ('not_started', 'live')"} {
		if !strings.Contains(sqlSelectCandidates, clause) {
			t.Errorf("candidate query lacks %q", clause)
		}
	}
	if !strings.Contains(sqlInsertGame, "ON CONFLICT (match_id) DO NOTHING") {
		t.Error("game insert must never touch an existing row")
	}
	if !strings.Contains(sqlResumeServicePause, "paused_by IS NULL") {
		t.Error("a service resume must never reopen an operator's pause")
	}
}

func TestDecodePaytable(t *testing.T) {
	lines, err := decodePaytable([]byte(`{"any2:P3":3500,"all3:NONE":100,"bogus":7}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines["any2:P3"] != 3500 || lines["all3:NONE"] != 100 {
		t.Errorf("lines: %v", lines)
	}
	if _, err := decodePaytable([]byte(`{"any2:P3":-1}`)); err == nil {
		t.Error("negative multiplier must be refused")
	}
	if _, err := decodePaytable([]byte(`{"any2:P3":"35"}`)); err == nil {
		t.Error("non-numeric multiplier must be refused")
	}
}

// recorder is a runner that records the SQL it was asked to execute.
type recorder struct {
	calls []string
}

func (r *recorder) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	r.calls = append(r.calls, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (r *recorder) QueryRow(context.Context, string, ...any) pgx.Row { return nil }

func (r *recorder) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, nil }
