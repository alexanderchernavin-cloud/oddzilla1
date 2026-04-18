// Oddin market descriptions XML shape. Returned by
//   GET /v1/descriptions/{lang}/markets
//
// Example (elided):
//
//   <market_descriptions response_code="OK">
//     <market id="1" name="Match winner - {way}way" variant="way:two">
//       <outcomes>
//         <outcome id="1" name="home"></outcome>
//         <outcome id="2" name="away"></outcome>
//       </outcomes>
//       <specifiers>
//         <specifier name="way" type="variable_text"></specifier>
//       </specifiers>
//     </market>
//     ...
//   </market_descriptions>
//
// Markets are keyed by (id, variant). `variant` is absent for most markets
// and present for families like best-of-N score grids ("best_of:3",
// "best_of:5") or way-count ("way:two", "way:three"). Empty string is the
// canonical "no variant" sentinel.

package oddinxml

import "encoding/xml"

type MarketDescriptions struct {
	XMLName      xml.Name              `xml:"market_descriptions"`
	ResponseCode string                `xml:"response_code,attr"`
	Markets      []MarketDescription   `xml:"market"`
}

type MarketDescription struct {
	ID         int                    `xml:"id,attr"`
	Name       string                 `xml:"name,attr"`
	Variant    string                 `xml:"variant,attr"`
	Outcomes   []OutcomeDescription   `xml:"outcomes>outcome"`
	Specifiers []SpecifierDescription `xml:"specifiers>specifier"`
}

type OutcomeDescription struct {
	ID   string `xml:"id,attr"`
	Name string `xml:"name,attr"`
}

type SpecifierDescription struct {
	Name string `xml:"name,attr"`
	Type string `xml:"type,attr"` // "decimal" | "integer" | "string" | "variable_text"
}
