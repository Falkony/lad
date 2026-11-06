let zone = 'Europe/Moscow'
export function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}
export function configureTimeZone(value: string) {
  if (!validTimeZone(value)) throw new Error('Неизвестный часовой пояс')
  zone = value
}
export const workspaceTimeZone = () => zone
/** A calendar cell is a civil date, not an instant to convert to another timezone. */
export function civilDate(date: Date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export const civilDateObject = (date: string) => new Date(date + 'T12:00:00')
export function dateInTimeZone(date = new Date(), timeZone = zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  return ['year', 'month', 'day'].map((key) => parts.find((p) => p.type === key)!.value).join('-')
}
