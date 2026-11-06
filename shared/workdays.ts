// Russian production calendar for a five-day working week (Labour Code, art. 112).
//
// Non-working holidays are fixed by the Labour Code. By default a holiday that falls on a weekend
// moves the day off to the next working day (not for the January holidays). Every year the
// government decree sets the actual transfers and may place those days elsewhere, so a year with
// a known decree uses only its list. Later years follow the general rule until the decree is added.
const fixedHolidays = [
  '01-01',
  '01-02',
  '01-03',
  '01-04',
  '01-05',
  '01-06',
  '01-07',
  '01-08',
  '02-23',
  '03-08',
  '05-01',
  '05-09',
  '06-12',
  '11-04',
]
const januaryHolidays = new Set(fixedHolidays.filter((d) => d.startsWith('01-')))
/** Government decrees: every extra day off of the year and working Saturdays. */
const decrees: Record<number, { off: string[]; work: string[] }> = {
  // Decree of 04.10.2024 No. 1335: 4 January → 2 May, 5 January → 31 December,
  // 23 February → 8 May, 8 March → 13 June, Saturday 1 November is worked for 3 November.
  2025: {
    off: ['2025-05-02', '2025-05-08', '2025-06-13', '2025-11-03', '2025-12-31'],
    work: ['2025-11-01'],
  },
  // Decree of 24.09.2025 No. 1466: 3 January → 9 January, 4 January → 31 December;
  // 8 March (Sunday) → 9 March and 9 May (Saturday) → 11 May by the general rule.
  2026: { off: ['2026-01-09', '2026-03-09', '2026-05-11', '2026-12-31'], work: [] },
}
export const knownDecreeYears = Object.keys(decrees).map(Number)

const utc = (date: string) => new Date(`${date}T00:00:00Z`)
const shift = (date: string, days: number) => {
  const value = utc(date)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
const isWeekend = (date: string) => [0, 6].includes(utc(date).getUTCDay())

const cache = new Map<number, { off: Set<string>; work: Set<string> }>()
function yearCalendar(year: number) {
  let calendar = cache.get(year)
  if (calendar) return calendar
  const y = String(year).padStart(4, '0')
  const holidays = fixedHolidays.map((d) => `${y}-${d}`)
  const off = new Set(holidays)
  const decree = decrees[year]
  // Art. 112: a holiday on a weekend gives a day off on the next working day (not for January).
  if (!decree)
    for (const holiday of holidays) {
      if (januaryHolidays.has(holiday.slice(5)) || !isWeekend(holiday)) continue
      let next = shift(holiday, 1)
      while (isWeekend(next) || off.has(next)) next = shift(next, 1)
      off.add(next)
    }
  for (const day of decree?.off || []) off.add(day)
  calendar = { off, work: new Set(decree?.work || []) }
  cache.set(year, calendar)
  return calendar
}

/** A weekend or a public holiday on a five-day working week. */
export function isNonWorkingDay(date: string) {
  const { off, work } = yearCalendar(Number(date.slice(0, 4)))
  if (work.has(date)) return false
  return off.has(date) || isWeekend(date)
}

/** The date itself if it is a working day, otherwise the last working day before it. */
export function previousWorkingDay(date: string) {
  let day = date
  while (isNonWorkingDay(day)) day = shift(day, -1)
  return day
}
