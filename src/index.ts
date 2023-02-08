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

function sortMains(lst: string[]): string[] {
  const keywords = [
    'taco',
    'chicken',
    'steak',
    'beef',
    'shrimp',
    'tofu',
    'seitan',
    'bacon',
    'sausage',
    'pork',
    'cod',
    'meatball',
    'tilapia',
    'salmon',
    'wing',
    'pizza',
    'pasta',
    'fried rice',
    'waffles',
    'french toast',
    'aloo gobi',
    'vindaloo'
  ]

  const items = new Set(lst)
  
  // this algorithm will, if there are multiple proteins on the list, order them by their ordering
  // in the keyword list
  // yes this is O(N^2) but it's fine

  const newLst: string[] = []
  for (const keyword of keywords) {
    for (const item of items) {
      if (item.toLowerCase().includes(keyword)) {
        items.delete(item)
        newLst.push(`<strong>${item.trim()}</strong>`)
      }
    }
  }

  for (const item of items) {
    newLst.push(item.trim())
  }

  return newLst
}

function parseMeal(meal: RawMeal): Meal {
  const startdate = DateTime.fromISO(meal.startdate)
  const enddate = DateTime.fromISO(meal.enddate)

  // definition of the HTML dietary tags
  // adapted from the chrome extension https://github.com/swat-sccs/sharples-chrome-extension
  const vegan = '<abbr class="tag vegan" title="Vegan">(v)</abbr>'
  const halal = '<abbr class="tag halal" title="Halal">(h)</abbr>'
  const veget = '<abbr class="tag veget" title="Vegetarian">(vg)</abbr>'
  // extra dietary tags
  const egg = '<abbr class="tag egg" title="Egg">(e)</abbr>'
  const milk = '<abbr class="tag milk" title="Milk">(m)</abbr>'
  const soy = '<abbr class="tag soy" title="Soy">(s)</abbr>'
  const wheat = '<abbr class="tag wheat" title="Wheat">(w)</abbr>'
  const fish = '<abbr class="tag fish" title="Fish">(f)</abbr>'
  const glutenfree = '<abbr class="tag gf" title="Gluten Free">(gf)</abbr>'
  const sesame = '<abbr class="tag sesame" title="Sesame">(ses)</abbr>'
  const alcohol = '<abbr class="tag alcohol" title="Alcohol">(a)</abbr>'

  const main1 = '<abbr title="Classics">Main 1</abbr>:'
  const main2 = '<abbr title="World of Flavor">Main 2</abbr>:'
  const main3 = '<abbr title="Spice of Life">Main 3</abbr>:'
  const veganMain = '<abbr title="Verdant & Vegan">Vegan Main</abbr>:'
  const salad = '<abbr title="Field of Greens">Salad</abbr>:'
  const dessert = '<abbr title="Daily Kneads">Dessert</abbr>:'
  const allergen = '<abbr title="Free Zone">Allergen Choice</abbr>:'

  // order for presentation
  const order = [main1, main2, main3, veganMain, allergen, salad, dessert]
  const exclude = ['Fired Up', "Grillin' Out"]

  return {
    title: meal.title,
    startdate,
    enddate,
    short_time: `${startdate.toFormat('h:mm')} to ${enddate.toFormat('h:mm')}`,
    short_date: startdate.toFormat('ccc M/d'),
    // split on the </span> that indicates the start of a new menu block
    // use the ending </span> to insert a comma instead
    items: meal.description
      .replace(/<\/span>/g, ': ')
      .split(/<span\s[^>]+>/)
      .map((item) =>
        decode(stripHtmlTags(item))
          .trim()
          .replace(/::vegan::/g, vegan)
          .replace(/::halal::/g, halal)
          .replace(/::vegetarian::/g, veget)
          .replace(/::egg::/g, egg)
          .replace(/::milk::/g, milk)
          .replace(/::soy::/g, soy)
          .replace(/::wheat::/g, wheat)
          .replace(/::fish::/g, fish)
          .replace(/::gluten free::/g, glutenfree)
          .replace(/::sesame::/g, sesame)
          .replace(/::alcohol::/g, alcohol)
          .replace(/ ::.*?::/g, '')
          .replace(/Classics:/g, main1)
          .replace(/World (?:of )?Flavor:/g, main2)
          .replace(/Verdant & Vegan:/g, veganMain)
          .replace(/Daily Kneads:/g, dessert)
          .replace(/Free Zone:/g, allergen)
          .replace(/Spice(?: of Life)?:/g, main3)
          .replace(/Field of Greens?:/g, salad),
      )
      .filter((m) => !exclude.some((exclusion) => m.startsWith(exclusion)))
      .filter((m) => !!m)
      .map((item) => {
        // strip leading ampersands from items
        const titleAndItems = item.split(': ')
        const title = titleAndItems[0]
        const items = titleAndItems[1]

        const processedItems = sortMains(
          items.split(', ').map((i) => i.replace(/^& /, '')),
        ).join(', ')
        return `${title}: ${processedItems}`
      })
      .sort(
        (i1, i2) =>
          order.findIndex((value) => i1.startsWith(value)) -
          order.findIndex((value) => i2.startsWith(value)),
      ),
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

async function handleRequest(event: FetchEvent): Promise<Response> {
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

  // console.log(JSON.stringify(rsp))

  const breakfast = rsp.data.today.data
    .filter((m: RawMeal) => m.title == 'Breakfast')
    .map(parseMeal)
    .map((m: Meal) => m.short_time)[0]
  const today = parseAndFilterMeals(rsp.data.today.data)

  // handle API requests
  if (new URL(event.request.url).pathname == "/api") {
    return new Response(JSON.stringify({
      lunch_time: today[0].short_time,
      lunch: today[0].items.map(i => stripHtmlTags(i)),
      dinner_time: today[1].short_time,
      dinner: today[1].items.map(i => stripHtmlTags(i))
    }))
  }

  const upcoming = groupMealsByDay(parseAndFilterMeals(rsp.data.upcoming.data))
  const essies = parseEssies(rsp.data.essies.data)

  return new Response(
    Mustache.render(indexPage, {
      date: now.toFormat('MMM d'),
      breakfast,
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
