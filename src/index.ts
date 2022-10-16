import { DateTime, Settings } from 'luxon'
import { decode } from 'html-entities'
import Mustache from 'mustache'

import indexPage from './index.html'
import errorPage from './error.html'

type RawMeal = {
  title: string
  startdate: string
  enddate: string
  description: string
}

type Meal = {
  title: string
  startdate: DateTime
  enddate: DateTime
  short_time: string
  short_date: string
  items: string[]
}

type Day = {
  short_date: string
  lunch?: Meal
  dinner?: Meal
}

type Handler = (event: FetchEvent) => Promise<Response>
type Middleware = (handler: Handler) => Handler

Settings.defaultZone = 'America/New_York'

const menuQuery = `query menu($todayStart: String, $todayEnd: String, $upcomingEnd: String) {
  today: cbordnetmenufeed(
    calendarId: "DCC",
    timeMin: $todayStart,
    timeMax: $todayEnd,
    order: ASC
  ) {
    data {
      title
      startdate
      enddate
      description
    }
  }
  upcoming: cbordnetmenufeed(
    calendarId: "DCC",
    timeMin: $todayEnd,
    timeMax: $upcomingEnd,
    order: ASC
  ) {
    data {
      title
      startdate
      enddate
      description
    }
  }
  essies: cbordnetmenufeed(
    calendarId: "r3r3af5a1gvf61ffe47b8i17d8@group.calendar.google.com",
    timeMin: $todayStart,
    timeMax: $todayEnd,
    order: ASC
  ) {
    data {
      title
      startdate
      enddate
      description
    }
  }
}
`

function stripHtmlTags(s: string): string {
  return s.replace(/<\/?[^>]+(>|$)/g, '')
}

function parseMeal(meal: RawMeal): Meal {
  const startdate = DateTime.fromISO(meal.startdate)
  const enddate = DateTime.fromISO(meal.enddate)

  return {
    title: meal.title,
    startdate,
    enddate,
    short_time: `${startdate.toFormat('h:mm')} to ${enddate.toFormat('h:mm')}`,
    short_date: startdate.toFormat('ccc M/d'),
    // split on <br> and newlines
    items: meal.description
      .split(/<\s*\/?\s*(?:(?:br)|(?:li))\s*\/?\s*>/)
      .map((item) =>
        decode(stripHtmlTags(item))
          .trim()
          .replace(/::(.*?)::/g, function (dietary) {
            switch (dietary) {
              case '::vegan::':
                return '(v)'
              case '::vegetarian::':
                return '(vg)'
              case '::kosher::':
                return '(k)'
              case '::halal::':
                return '(h)'
              case '::gluten-free::':
                return '(gf)'
              default:
                return ''
            }
          }),
      )
      .filter((m) => !!m),
  }
}

function parseAndFilterMeals(rawMeals: RawMeal[]): Meal[] {
  return rawMeals
    .map(parseMeal)
    .filter((m) => ['Brunch', 'Lunch', 'Dinner'].includes(m.title))
    .filter((m) => m.items.length > 0)
}

function groupMealsByDay(meals: Meal[]): Day[] {
  const days: Record<string, Day> = {}
  for (const meal of meals) {
    if (!days[meal.short_date]) {
      days[meal.short_date] = {
        short_date: meal.short_date,
      }
    }

    switch (meal.title) {
      case 'Brunch':
      case 'Lunch':
        days[meal.short_date].lunch = meal
        break
      case 'Dinner':
        days[meal.short_date].dinner = meal
    }
  }
  return Object.values(days)
}

function parseEssies(meals: RawMeal[]): string | undefined {
  if (!meals[0]) {
    return
  }

  const description = meals[0].description
  const special = description
    .split(/<\s*b\s*>/)
    .filter((line) => line.toLowerCase().includes('special'))[0]

  if (!special) {
    return
  }

  const food = decode(special).split(/special/i)[1] || ''
  return stripHtmlTags(food).trim()
}

async function handleRequest(event: Event): Promise<Response> {
  const now = DateTime.now()

  const url = new URL('https://dash.swarthmore.edu/graphql')
  url.searchParams.set('query', menuQuery)
  url.searchParams.set('operationName', 'menu')
  url.searchParams.set(
    'variables',
    JSON.stringify({
      todayStart: now.startOf('day').toISO(),
      todayEnd: now.endOf('day').toISO(),
      upcomingEnd: now.plus({ days: 7 }).endOf('day').toISO(),
    }),
  )

  const rsp = (await (await fetch(url.toString())).json()) as any

  console.log(JSON.stringify(rsp))

  const today = parseAndFilterMeals(rsp.data.today.data)
  const upcoming = groupMealsByDay(parseAndFilterMeals(rsp.data.upcoming.data))
  const essies = parseEssies(rsp.data.essies.data)

  return new Response(
    Mustache.render(indexPage, {
      date: now.toFormat('MMM d'),
      today,
      upcoming,
      essies,
    }),
    {
      headers: { 'content-type': 'text/html' },
    },
  )
}

const withCache: Middleware = (handler) => async (event) => {
  const cache = caches.default
  const cacheUrl = new URL(event.request.url)
  const cacheKey = new Request(cacheUrl.toString(), event.request)

  let response = await caches.default.match(cacheKey)
  if (!response) {
    response = await handler(event)

    if (response.status === 200) {
      response = new Response(response.body, response)
      response.headers.append('Cache-Control', 's-maxage=300')
      event.waitUntil(cache.put(cacheKey, response.clone()))
    }
  }

  return response
}

const withTry: Middleware = (handler) => async (event) => {
  try {
    return await handler(event)
  } catch (error) {
    console.log(error)
    return new Response(errorPage, {
      headers: { 'content-type': 'text/html' },
      status: 500,
    })
  }
}

addEventListener('fetch', (event) => {
  event.respondWith(withCache(withTry(handleRequest))(event))
})
