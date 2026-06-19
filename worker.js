// ═══════════════════════════════════════════════════════════════
// Cloudflare Worker — worldcup-results
// يجلب نتائج كأس العالم 2026 من TheSportsDB وopenfootball
// انشره على workers.cloudflare.com ثم ضع رابطه في WORKER_URL
// ═══════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
}

addEventListener('fetch', e => e.respondWith(handle(e.request)))

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // جلب من المصدرين بشكل متوازٍ
    const [r1, r2] = await Promise.allSettled([
      getSportsDB(),
      getOpenfootball()
    ])

    const s1 = r1.status === 'fulfilled' ? r1.value : []
    const s2 = r2.status === 'fulfilled' ? r2.value : []
    const sportsdbOk = r1.status === 'fulfilled' && s1.length > 0
    const openfootballOk = r2.status === 'fulfilled' && s2.length > 0

    // دمج النتائج مع تحقق المصدر الثاني
    const merged = mergeResults(s1, s2)

    return new Response(JSON.stringify({
      ok: true,
      results: merged,
      sources: { sportsdb: sportsdbOk, openfootball: openfootballOk },
      counts: { sportsdb: s1.length, openfootball: s2.length, merged: merged.length },
      ts: new Date().toISOString()
    }), { headers: CORS })

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: CORS
    })
  }
}

// ── دمج النتائج من مصدرين ──────────────────────────────────────
function normTeam(name) {
  return String(name || '').toLowerCase()
    .replace(/[​-‏‪-‮]/g, '')
    .replace(/[-_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameMatch(a, b) {
  const [ah, aa] = [normTeam(a.home), normTeam(a.away)]
  const [bh, ba] = [normTeam(b.home), normTeam(b.away)]
  return (ah === bh && aa === ba) || (ah === ba && aa === bh)
}

function mergeResults(primary, secondary) {
  const result = primary.map(r => ({
    ...r,
    hasSecondSource: false,
    verified: false,
    secondScore: null
  }))

  secondary.forEach(r2 => {
    const idx = result.findIndex(r1 => sameMatch(r1, r2))
    if (idx >= 0) {
      result[idx].hasSecondSource = true
      const scoresMatch =
        (result[idx].homeScore === r2.homeScore && result[idx].awayScore === r2.awayScore) ||
        // تحقق من احتمال عكس الفريقين بين المصدرين
        (result[idx].homeScore === r2.awayScore && result[idx].awayScore === r2.homeScore)
      if (scoresMatch) {
        result[idx].verified = true
      } else {
        result[idx].secondScore = `${r2.homeScore}-${r2.awayScore}`
      }
    } else {
      // مباراة موجودة في المصدر الثاني فقط
      result.push({
        ...r2,
        hasSecondSource: false,
        verified: false,
        secondScore: null
      })
    }
  })

  return result
}

// ── المصدر 1: TheSportsDB ──────────────────────────────────────
async function getSportsDB() {
  // نجرّب معرّفات الدوري المحتملة لكأس العالم 2026 في TheSportsDB
  // المعرّف 4429 هو FIFA World Cup بصفة عامة في قاعدة TheSportsDB
  const leagueIds = ['4429', '140280', '140325']
  const seasons = ['2025-2026', '2026', '2026-2027']

  for (const id of leagueIds) {
    for (const s of seasons) {
      try {
        const url = `https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=${id}&s=${s}`
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'WorldCup2026/1.0' },
          cf: { cacheTtl: 60 }
        })
        if (!resp.ok) continue

        const data = await resp.json()
        const events = data.events || []
        if (!events.length) continue

        const results = parseSportsDBEvents(events)
        if (results.length > 0) return results
      } catch (_) { continue }
    }
  }

  // محاولة أخيرة: جلب آخر المباريات المنتهية للبطولة
  try {
    const url = 'https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=FIFA+World+Cup+2026'
    const resp = await fetch(url, { cf: { cacheTtl: 60 } })
    if (resp.ok) {
      const data = await resp.json()
      const events = data.event || data.events || []
      const results = parseSportsDBEvents(events)
      if (results.length > 0) return results
    }
  } catch (_) { /* تجاهل */ }

  return []
}

function parseSportsDBEvents(events) {
  const results = []
  for (const e of events) {
    const s1 = e.intHomeScore
    const s2 = e.intAwayScore
    if (s1 === null || s1 === undefined || s1 === '') continue
    if (s2 === null || s2 === undefined || s2 === '') continue

    const finished =
      e.strStatus === 'Match Finished' ||
      e.strStatus === 'FT' ||
      e.strProgress === 'FT' ||
      (String(e.strStatus || '').toLowerCase().includes('finish'))

    if (!finished) continue

    results.push({
      home: e.strHomeTeam,
      away: e.strAwayTeam,
      homeScore: parseInt(s1),
      awayScore: parseInt(s2),
      finished: true,
      date: e.dateEvent
    })
  }
  return results
}

// ── المصدر 2: openfootball JSON ───────────────────────────────
async function getOpenfootball() {
  const urls = [
    'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json',
    'https://raw.githubusercontent.com/openfootball/world-cup/master/2026/worldcup.json'
  ]

  for (const url of urls) {
    try {
      const resp = await fetch(url, { cf: { cacheTtl: 60 } })
      if (!resp.ok) continue

      const data = await resp.json()
      const results = []

      // دعم بنيات مختلفة لملف openfootball
      const sections = data.rounds || data.groups || data.matches || []

      for (const section of sections) {
        const matches = section.matches || section.games || (Array.isArray(section) ? section : [section])
        for (const m of matches) {
          const score = m.score || m.result
          if (!score) continue

          const ft = score.ft || score.fulltime || score
          if (!Array.isArray(ft) || ft.length < 2) continue
          if (ft[0] === null || ft[0] === undefined) continue

          const t1 = m.team1 || m.home_team || (m.teams && m.teams[0])
          const t2 = m.team2 || m.away_team || (m.teams && m.teams[1])
          if (!t1 || !t2) continue

          const t1name = typeof t1 === 'object' ? (t1.name || t1.code || String(t1)) : String(t1)
          const t2name = typeof t2 === 'object' ? (t2.name || t2.code || String(t2)) : String(t2)

          results.push({
            home: t1name,
            away: t2name,
            homeScore: parseInt(ft[0]),
            awayScore: parseInt(ft[1]),
            finished: true,
            date: m.date
          })
        }
      }

      if (results.length > 0) return results
    } catch (_) { continue }
  }

  return []
}
