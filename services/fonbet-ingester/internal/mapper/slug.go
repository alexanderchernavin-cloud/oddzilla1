package mapper

import (
	"strconv"
	"strings"
	"unicode"
)

// Cyrillic → latin transliteration for slugs. Fonbet names arrive in
// Russian when FONBET_LANG=ru; slugs must stay ASCII for URLs.
var translit = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e", 'ё': "e", 'ж': "zh", 'з': "z",
	'и': "i", 'й': "y", 'к': "k", 'л': "l", 'м': "m", 'н': "n", 'о': "o", 'п': "p", 'р': "r",
	'с': "s", 'т': "t", 'у': "u", 'ф': "f", 'х': "h", 'ц': "ts", 'ч': "ch", 'ш': "sh", 'щ': "sch",
	'ъ': "", 'ы': "y", 'ь': "", 'э': "e", 'ю': "yu", 'я': "ya",
	'і': "i", 'ї': "yi", 'є': "ye", 'ґ': "g", 'ә': "a", 'ғ': "g", 'қ': "k", 'ң': "n", 'ө': "o",
	'ұ': "u", 'ү': "u", 'һ': "h",
}

// Slugify lowercases, transliterates Cyrillic and collapses everything
// that is not [a-z0-9] into single dashes. Truncated to maxLen runes.
func Slugify(s string, maxLen int) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(s) {
		var piece string
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			piece = string(r)
		default:
			if t, ok := translit[r]; ok {
				piece = t
			} else if unicode.IsLetter(r) || unicode.IsDigit(r) {
				// Non-Cyrillic non-ASCII letter (é, ü, ...): keep the
				// base ASCII when it is one, otherwise drop.
				piece = asciiFold(r)
			}
		}
		if piece == "" {
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
			continue
		}
		b.WriteString(piece)
		lastDash = false
	}
	out := strings.Trim(b.String(), "-")
	if maxLen > 0 && len(out) > maxLen {
		out = strings.Trim(out[:maxLen], "-")
	}
	return out
}

func asciiFold(r rune) string {
	switch r {
	case 'à', 'á', 'â', 'ã', 'ä', 'å':
		return "a"
	case 'ç':
		return "c"
	case 'è', 'é', 'ê', 'ë':
		return "e"
	case 'ì', 'í', 'î', 'ï':
		return "i"
	case 'ñ':
		return "n"
	case 'ò', 'ó', 'ô', 'õ', 'ö', 'ø':
		return "o"
	case 'ù', 'ú', 'û', 'ü':
		return "u"
	case 'ý', 'ÿ':
		return "y"
	case 'ß':
		return "ss"
	}
	return ""
}

func itoa(n int) string { return strconv.Itoa(n) }
