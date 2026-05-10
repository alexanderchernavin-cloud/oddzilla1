package cc.oddzilla.app.common

import java.math.BigDecimal
import java.math.RoundingMode

// Money helpers. Server sends bigint micros as decimal strings — we
// never coerce to Long until display time, and only via BigInteger /
// BigDecimal so 9_000_000_000_000_000+ values don't truncate.
//
// 1 unit = 1_000_000 micro for both USDC and OZ (6 decimals).

private val ONE_UNIT = BigDecimal.valueOf(1_000_000L)

fun microToDecimal(micro: String): BigDecimal {
    val value = micro.takeIf { it.isNotBlank() } ?: return BigDecimal.ZERO
    return BigDecimal(value).divide(ONE_UNIT, 6, RoundingMode.DOWN)
}

fun decimalToMicro(decimal: BigDecimal): String =
    decimal.multiply(ONE_UNIT).setScale(0, RoundingMode.DOWN).toPlainString()

fun decimalToMicro(decimal: String): String? = runCatching {
    BigDecimal(decimal.trim()).let { decimalToMicro(it) }
}.getOrNull()

fun formatMoney(micro: String, currency: String): String {
    val decimal = microToDecimal(micro)
    val display = decimal.setScale(2, RoundingMode.DOWN).toPlainString()
    return "$display $currency"
}

fun formatStakeInput(micro: String): String =
    microToDecimal(micro).setScale(2, RoundingMode.DOWN).toPlainString()

fun formatOdds(odds: String?): String {
    if (odds.isNullOrBlank()) return "—"
    val n = odds.toBigDecimalOrNull() ?: return "—"
    return n.setScale(2, RoundingMode.DOWN).toPlainString()
}
