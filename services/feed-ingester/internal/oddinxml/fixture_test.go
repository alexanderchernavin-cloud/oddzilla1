package oddinxml

import (
	"encoding/xml"
	"testing"
)

func TestDecodeFixtureTvChannels(t *testing.T) {
	// Trimmed shape from /v1/sports/{lang}/sport_events/{matchURN}/fixture
	// per oddin-gg/oddsfeedschema schema/rest/fixtures_fixture.xsd. We
	// only assert the tv_channels block here; the rest of the fixture
	// decoder is exercised by callers.
	body := []byte(`
<fixtures_fixture>
  <fixture id="od:match:99" name="A vs B" scheduled="2026-05-06T10:00:00Z">
    <tournament id="od:tournament:1" name="T">
      <sport id="od:sport:3" name="Counter-Strike" abbreviation="cs2"/>
    </tournament>
    <competitors>
      <competitor id="od:competitor:1" name="A" qualifier="home"/>
      <competitor id="od:competitor:2" name="B" qualifier="away"/>
    </competitors>
    <tv_channels>
      <tv_channel name="Twitch EN" language="en" stream_url="https://www.twitch.tv/esl_csgo"/>
      <tv_channel name="YouTube RU" language="ru" stream_url="https://www.youtube.com/watch?v=abc123"/>
      <tv_channel name="Placeholder"/>
    </tv_channels>
  </fixture>
</fixtures_fixture>`)
	var fx FixtureResponse
	if err := xml.Unmarshal(body, &fx); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := fx.Fixture.TvChannels.Channels
	if len(got) != 3 {
		t.Fatalf("want 3 channels, got %d (%+v)", len(got), got)
	}
	if got[0].Name != "Twitch EN" || got[0].Language != "en" || got[0].StreamURL != "https://www.twitch.tv/esl_csgo" {
		t.Fatalf("twitch row mismatch: %+v", got[0])
	}
	if got[1].Name != "YouTube RU" || got[1].Language != "ru" || got[1].StreamURL != "https://www.youtube.com/watch?v=abc123" {
		t.Fatalf("youtube row mismatch: %+v", got[1])
	}
	if got[2].StreamURL != "" {
		t.Fatalf("placeholder row should have empty stream_url, got %q", got[2].StreamURL)
	}
}

func TestDecodeFixtureTvChannelsMissing(t *testing.T) {
	// Most fixtures don't carry a <tv_channels> block at all. The
	// decoder must produce a zero-length slice (not panic) so the
	// resolver leaves matches.tv_channels as-is.
	body := []byte(`
<fixtures_fixture>
  <fixture id="od:match:99">
    <tournament id="od:tournament:1" name="T">
      <sport id="od:sport:3" name="x"/>
    </tournament>
    <competitors/>
  </fixture>
</fixtures_fixture>`)
	var fx FixtureResponse
	if err := xml.Unmarshal(body, &fx); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(fx.Fixture.TvChannels.Channels) != 0 {
		t.Fatalf("want 0 channels for missing block, got %d", len(fx.Fixture.TvChannels.Channels))
	}
}
