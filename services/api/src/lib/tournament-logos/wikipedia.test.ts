// Unit tests for the Wikipedia infobox extractor.
//
// Wikipedia is the highest-coverage source for traditional sport and the
// least free, so what it hands back has to be a MARK rather than merely
// a picture. The cases below are the real ones.
//
// Run with: tsx --test src/lib/tournament-logos/wikipedia.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractInfoboxLogo } from "./wikipedia.js";

describe("extractInfoboxLogo", () => {
  it("takes the logo field", () => {
    assert.equal(
      extractInfoboxLogo("{{Infobox football league\n| logo = Liiga logo.svg\n| country = Finland\n}}"),
      "Liiga logo.svg",
    );
  });

  it("unwraps a [[File:...]] value", () => {
    assert.equal(
      extractInfoboxLogo("| logo = [[File:Currie Cup logo.svg|200px|alt=x]]\n"),
      "Currie Cup logo.svg",
    );
  });

  it("REFUSES a photograph sitting in the image field", () => {
    // The real miss: "Test cricket" has no logo field, and its `image`
    // is a match photograph. The first cut took it and would have put a
    // picture of England v South Africa on a cricket series.
    assert.equal(
      extractInfoboxLogo("{{Infobox cricket\n| image = England vs South Africa.jpg\n}}"),
      null,
    );
  });

  it("still takes an image field that names a mark", () => {
    // Plenty of league infoboxes carry the crest under `image`; the
    // filename is what distinguishes those from photographs.
    assert.equal(
      extractInfoboxLogo("| image = Belgian Pro League logo (2020).png\n"),
      "Belgian Pro League logo (2020).png",
    );
    assert.equal(extractInfoboxLogo("| image = Club crest.svg\n"), "Club crest.svg");
  });

  it("rejects JPEGs outright — a mark is not published as one", () => {
    assert.equal(extractInfoboxLogo("| logo = Something logo.jpg\n"), null);
    assert.equal(extractInfoboxLogo("| logo = Something logo.jpeg\n"), null);
  });

  it("prefers logo over a competing image field", () => {
    assert.equal(
      extractInfoboxLogo("| image = Stadium photo.png\n| logo = Real logo.svg\n"),
      "Real logo.svg",
    );
  });

  it("ignores template calls and non-files", () => {
    assert.equal(extractInfoboxLogo("| logo = {{some template}}\n"), null);
    assert.equal(extractInfoboxLogo("| logo = \n"), null);
    assert.equal(extractInfoboxLogo("no infobox here at all"), null);
  });
});
