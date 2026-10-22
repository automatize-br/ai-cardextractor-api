/**
 * Chave de dia `YYYY-MM-DD` no fuso America/Sao_Paulo (independente do TZ do
 * host). Usada em contadores diarios.
 */
export function dayKey(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(date)
}
