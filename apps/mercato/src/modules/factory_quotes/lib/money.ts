// Six decimal places for inputs; intermediate products retain all digits.
export const S = 1_000_000n
export const decimalPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/
export function exact(value: string): bigint {
  if (!decimalPattern.test(value)) throw new Error('invalid_decimal')
  const [integer, fraction = ''] = value.split('.')
  return BigInt(integer) * S + BigInt(fraction.padEnd(6, '0'))
}
export function display(n: bigint, d: bigint, digits = 2): string {
  if (d <= 0n) throw new Error('invalid_denominator')
  const scale = 10n ** BigInt(digits)
  const abs = n < 0n ? -n : n
  const rounded = (abs * scale * 2n + d) / (d * 2n)
  const sign = n < 0n && rounded > 0n ? '-' : ''
  return digits ? `${sign}${rounded / scale}.${(rounded % scale).toString().padStart(digits, '0')}` : `${sign}${rounded}`
}
