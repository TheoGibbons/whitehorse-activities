// Scrapes today's swimming, skating, recreation, community events and open-gym info into dist/index.html.
import { cp, mkdir, writeFile } from 'node:fs/promises';

const TZ = 'America/Whitehorse';
const UA = 'Mozilla/5.0 (compatible; whitehorse-activities)';
const TIMEOUT_MS = 30_000;
const PM = 'https://whitehorse.perfectmind.com/24547/Clients';
const WIDGET_ID = '011c1070-84e5-4b2f-8e88-65a3bdd0397e';
const GYM_URL = 'https://www.polarettes.org/open-gym';

// Sessions whose names match get blue text.
const HIGHLIGHT = /motoring munchkins/i;

const CALENDARS = [
  { title: 'Swimming', calendarId: '609c5691-1bc3-d63a-6104-ce595ca31317' },
  { title: 'Ice Skating', calendarId: 'ecfea22a-afb2-4be1-90a5-2148b6cad1f4' },
  { title: 'Recreation', calendarId: '420604eb-ea82-4980-8b4a-b18a513c0e5d' },
  { title: 'Community Events', calendarId: '8acc8d53-da75-4c05-b17e-ec156133bea5' },
];

const bookingPageUrl = calendarId =>
  `${PM}/BookMe4BookingPages/Classes?calendarId=${calendarId}&widgetId=${WIDGET_ID}&embed=False`;

const request = (url, init = {}) =>
  fetch(url, { ...init, headers: { 'user-agent': UA, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "12:30 PM" -> 750
function toMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(time?.trim() ?? '');
  if (!m) return null;
  return ((m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
}

// The class list comes from an XHR that needs the session cookie and
// anti-forgery token handed out by the booking page itself.
async function fetchClasses(calendarId, date) {
  const pageUrl = bookingPageUrl(calendarId);
  const page = await request(pageUrl);
  if (!page.ok) throw new Error(`booking page returned HTTP ${page.status}`);
  const token = (await page.text()).match(/__RequestVerificationToken" type="hidden" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('booking page had no __RequestVerificationToken');
  const cookie = page.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const res = await request(`${PM}/BookMe4BookingPagesV2/ClassesV2`, {
    method: 'POST',
    headers: { cookie, referer: pageUrl, 'x-requested-with': 'XMLHttpRequest' },
    body: new URLSearchParams({
      calendarId,
      widgetId: WIDGET_ID,
      page: '0',
      'values[0][Name]': 'Date Range',
      'values[0][Value]': `${date}T00:00:00.000Z`,
      // Multi-day events only come back once the range reaches their last day, so look a week ahead.
      'values[0][Value2]': `${addDays(date, 7)}T00:00:00.000Z`,
      'values[0][ValueKind]': '6',
      __RequestVerificationToken: token,
    }),
  });
  if (!res.ok) throw new Error(`ClassesV2 returned HTTP ${res.status}`);
  const { classes } = await res.json().catch(() => ({}));
  if (!Array.isArray(classes)) throw new Error('ClassesV2 response had no classes list');

  // The API returns several days at a time, so keep only today's. A multi-day all-day event
  // (e.g. a three-day contest) is listed once under its first day, so keep it while it runs.
  const ymd = date.replaceAll('-', '');
  const lastDay = c => addDays(c.OccurrenceDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), Math.floor((c.DurationInMinutes - 1) / 1440));
  return classes
    .filter(c => c.OccurrenceDate === ymd || (c.AllDayEvent && c.OccurrenceDate < ymd && lastDay(c) >= date))
    .map(c => {
      const start = toMinutes(c.FormattedStartTime);
      let end = toMinutes(c.FormattedEndTime);
      if (start != null && end != null && end <= start) end = 24 * 60;
      return {
        // Some names carry a "(1/3)"-style suffix, e.g. "Motoring Munchkins (1/3)".
        name: c.EventName?.replace(/\s*\(\d+\/\d+\)$/, ''),
        startText: c.FormattedStartTime?.replace(/^0/, ''),
        endText: c.FormattedEndTime?.replace(/^0/, ''),
        start,
        end,
        allDay: c.AllDayEvent,
        facility: c.Facility,
        ages: c.AgeRestrictions,
        spots: c.Spots,
      };
    });
}

const decode = s =>
  s?.replace(/&(amp|quot|#39|#x27|lt|gt);/g, e => ({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' })[e]);

// The drop-in times only exist as text inside an image, so we just show the image.
async function fetchGymImage() {
  const res = await request(GYM_URL);
  if (!res.ok) throw new Error(`${GYM_URL} returned HTTP ${res.status}`);
  const tag = (await res.text()).match(/<img\b[^>]*>/g)?.find(t => /\salt="[^"]*drop[ -]?in/i.test(t));
  if (!tag) throw new Error(`no "DROP IN" image found on ${GYM_URL}`);
  const attr = name => decode(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]);
  const src = attr('src');
  if (!src?.startsWith('https://')) throw new Error(`unexpected image src: ${src}`);
  return {
    src,
    srcset: attr('srcset'),
    width: attr('width'),
    height: attr('height'),
    alt: attr('alt'),
    // Wix serves the untransformed original if you drop the /v1/... suffix.
    full: src.replace(/\/v1\/.*$/, ''),
  };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const describe = err => (err.cause ? `${err.message} (${err.cause.message ?? err.cause})` : err.message);

function renderClasses(result) {
  if (result.status === 'rejected') return `<p class="empty">Couldn't load. See Errors below.</p>`;
  const items = result.value;
  if (!items.length) return `<p class="empty">Nothing scheduled today.</p>`;
  const showFacility = new Set(items.map(i => i.facility)).size > 1;
  const rows = items.map(i => {
    const meta = [showFacility && i.facility, i.ages && `Ages ${i.ages}`, i.spots].filter(Boolean).join(' · ');
    const timed = !i.allDay && i.start != null && i.end != null;
    const time = timed ? `${esc(i.startText)}<span>to ${esc(i.endText)}</span>` : 'All day';
    return `<li${timed ? ` data-start="${i.start}" data-end="${i.end}"` : ''}>
        <div class="time">${time}</div>
        <div><div class="name${HIGHLIGHT.test(i.name) ? ' highlight' : ''}">${esc(i.name)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
      </li>`;
  });
  return `<ul class="sessions">${rows.join('')}</ul>`;
}

function renderGym(result) {
  if (result.status === 'rejected') return `<p class="empty">Couldn't load. See Errors below.</p>`;
  const img = result.value;
  return `<a href="${esc(img.full)}"><img src="${esc(img.src)}"${img.srcset ? ` srcset="${esc(img.srcset)}"` : ''} sizes="(max-width: 600px) 100vw, 600px" width="${esc(img.width)}" height="${esc(img.height)}" alt="Open gym drop-in schedule (${esc(img.alt)})"></a>
    <p class="meta">Weekly drop-in schedule. Tap to open full size.</p>`;
}

function render({ today, now, calendars, gym, errors }) {
  const dateText = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  const updatedText = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(now);
  const section = (title, href, body) => `
  <section>
    <h2>${esc(title)} <a class="src" href="${esc(href)}">source</a></h2>
    ${body}
  </section>`;
  const sections = calendars.map(c => section(c.title, bookingPageUrl(c.calendarId), renderClasses(c.result)));
  // Gymnastics goes right after Swimming and Ice Skating, ahead of the broader listings.
  sections.splice(2, 0, section('Gymnastics', GYM_URL, renderGym(gym)));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What's On Today</title>
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f4; --fg: #1c1c1a; --muted: #6b6b65; --line: #e1e1dc;
    --now-bg: #e3f3e7; --now-fg: #1d6633; --warn-bg: #fff4d6; --warn-fg: #6b4e00; --err: #b42318; --highlight: #1d4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151514; --fg: #ececea; --muted: #9b9b95; --line: #2d2d2b;
      --now-bg: #16301f; --now-fg: #8fd6a4; --warn-bg: #3a2f10; --warn-fg: #f3d27a; --err: #ff8a80; --highlight: #8ab4ff;
    }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.6rem; margin: 0; }
  .sub { color: var(--muted); margin: 2px 0 0; }
  .stale { background: var(--warn-bg); color: var(--warn-fg); padding: 10px 12px; border-radius: 6px; margin-top: 16px; }
  section { margin-top: 32px; }
  h2 { display: flex; align-items: baseline; justify-content: space-between; font-size: 1.15rem; margin: 0 0 4px; padding-bottom: 6px; border-bottom: 2px solid var(--fg); }
  h2 .src { font-size: .8rem; font-weight: 400; color: var(--muted); }
  .sessions { list-style: none; margin: 0; padding: 0; }
  .sessions li { display: grid; grid-template-columns: 5.5em 1fr; gap: 12px; padding: 10px 8px; margin: 0 -8px; border-bottom: 1px solid var(--line); border-radius: 6px; }
  .time { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .time span { display: block; font-weight: 400; font-size: .85rem; color: var(--muted); }
  .name { font-weight: 500; }
  .highlight { color: var(--highlight); }
  .meta, .empty { color: var(--muted); font-size: .875rem; }
  .past { opacity: .4; }
  .now { background: var(--now-bg); }
  .now .name::after { content: "On now"; margin-left: 8px; font-size: .75rem; font-weight: 600; color: var(--now-fg); text-transform: uppercase; letter-spacing: .04em; }
  img { display: block; max-width: 100%; height: auto; margin-top: 8px; border-radius: 6px; }
  .errors { padding-left: 1.2em; color: var(--err); }
  a { color: inherit; }
</style>
</head>
<body data-date="${today}">
<main>
  <header>
    <h1>What's On Today</h1>
    <p class="sub">${esc(dateText)} · updated ${esc(updatedText)}</p>
    <p class="stale" id="stale" hidden>This page hasn't been refreshed since ${esc(dateText)}, so the times below may not be today's.</p>
  </header>
  ${sections.join('')}
  <section>
    <h2>Errors</h2>
    ${errors.length ? `<ul class="errors">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>'}
  </section>
</main>
<script>
  // Dim finished sessions, highlight current ones, and flag the page if it's from another day.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: '${TZ}', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function tick() {
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    const fresh = \`\${p.year}-\${p.month}-\${p.day}\` === document.body.dataset.date;
    const now = Number(p.hour) * 60 + Number(p.minute);
    document.getElementById('stale').hidden = fresh;
    for (const li of document.querySelectorAll('[data-start]')) {
      li.classList.toggle('past', fresh && now >= Number(li.dataset.end));
      li.classList.toggle('now', fresh && now >= Number(li.dataset.start) && now < Number(li.dataset.end));
    }
  }
  tick();
  setInterval(tick, 60_000);
</script>
</body>
</html>
`;
}

const now = new Date();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);

const [gym, ...results] = await Promise.allSettled([
  fetchGymImage(),
  ...CALENDARS.map(c => fetchClasses(c.calendarId, today)),
]);
const calendars = CALENDARS.map((c, i) => ({ ...c, result: results[i] }));

const errors = [...calendars, { title: 'Gymnastics', result: gym }]
  .filter(s => s.result.status === 'rejected')
  .map(s => `${s.title}: ${describe(s.result.reason)}`);
for (const e of errors) console.error(e);

await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await writeFile('dist/index.html', render({ today, now, calendars, gym, errors }));
console.log(`Wrote dist/index.html for ${today} (${errors.length} error${errors.length === 1 ? '' : 's'})`);
