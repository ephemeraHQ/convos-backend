// Static payload for the iOS empty-state CTAs shown on the Convos and
// Things tabs for brand-new installs. The app ships the same shape
// bundled and refreshes from GET /api/v2/empty-state-mocks once per
// launch, so this payload can rotate copy and examples without an app
// release. The iOS decoder lives at
// Convos/Conversations List/Empty State/EmptyStateMocksProvider.swift
// in convos-ios.

export type EmptyStateMockConversation = {
  id: string;
  name: string;
  emoji: string;
  messageText: string;
};

export type EmptyStateMockStuff = {
  id: string;
  title: string;
  emoji: string | null;
  // Inline, self-contained HTML document. The app writes it to disk and
  // renders a preview image through the same WKWebView snapshot pipeline
  // used for real agent-produced files, so it should be a complete page
  // that looks good at a 160pt-wide tile and supports
  // prefers-color-scheme.
  html: string;
};

export type EmptyStateMocksPayload = {
  conversations: EmptyStateMockConversation[];
  stuffs: EmptyStateMockStuff[];
};

const DINNER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dinner suggestion</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #FFF7F0;
    --card: #FFFFFF;
    --text: #1C1B1A;
    --muted: #8A8580;
    --accent: #FC4F37;
    --chip: #FCEFE4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1C1816;
      --card: #2A2522;
      --text: #F5F1ED;
      --muted: #A39C95;
      --chip: #3A322C;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, system-ui, sans-serif;
    padding: 10px;
  }
  .hero {
    background: linear-gradient(135deg, #FFB37A, #FC4F37);
    border-radius: 10px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
  }
  h1 { font-size: 13px; font-weight: 700; margin: 8px 2px 2px; }
  .sub { font-size: 9px; color: var(--muted); margin: 0 2px 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    background: var(--chip);
    border-radius: 999px;
    font-size: 8px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  .time {
    margin-top: 7px;
    font-size: 9px;
    color: var(--accent);
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="hero">🥗</div>
  <h1>Crispy salmon bowls</h1>
  <p class="sub">Fresh, fast, and kid-approved</p>
  <div class="chips">
    <span class="chip">salmon</span>
    <span class="chip">rice</span>
    <span class="chip">avocado</span>
    <span class="chip">cucumber</span>
  </div>
  <p class="time">25 min &middot; serves 4</p>
</body>
</html>
`;

const PACKING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packing list</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #F0F6FF;
    --text: #16202E;
    --muted: #7A8699;
    --accent: #2E6BE6;
    --row: #FFFFFF;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161B24;
      --text: #EFF3F9;
      --muted: #939DAD;
      --row: #232B38;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, system-ui, sans-serif;
    padding: 10px;
  }
  h1 { font-size: 13px; font-weight: 700; }
  .sub { font-size: 9px; color: var(--muted); margin: 2px 0 8px; }
  .item {
    background: var(--row);
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    margin-bottom: 4px;
    font-size: 9px;
  }
  .box {
    width: 11px;
    height: 11px;
    border-radius: 4px;
    border: 1.5px solid var(--muted);
    flex: none;
  }
  .done .box {
    background: var(--accent);
    border-color: var(--accent);
  }
  .done span { text-decoration: line-through; color: var(--muted); }
</style>
</head>
<body>
  <h1>🎒 Tahoe packing list</h1>
  <p class="sub">Shared with everyone in the convo</p>
  <div class="item done"><div class="box"></div><span>Ski jackets &amp; gloves</span></div>
  <div class="item done"><div class="box"></div><span>Snow boots</span></div>
  <div class="item"><div class="box"></div><span>Board games</span></div>
  <div class="item"><div class="box"></div><span>Groceries for Saturday</span></div>
  <div class="item"><div class="box"></div><span>Sunscreen</span></div>
</body>
</html>
`;

const WEEK_PLAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekly plan</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #F4FFF4;
    --text: #15241A;
    --muted: #7E9485;
    --accent: #2FA45C;
    --row: #FFFFFF;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151D17;
      --text: #ECF7EF;
      --muted: #8FA897;
      --row: #202B23;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, system-ui, sans-serif;
    padding: 10px;
  }
  h1 { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .row {
    background: var(--row);
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 7px;
    margin-bottom: 4px;
  }
  .day {
    font-size: 8px;
    font-weight: 700;
    color: var(--accent);
    width: 24px;
    flex: none;
  }
  .what { font-size: 9px; }
  .when { font-size: 8px; color: var(--muted); margin-left: auto; }
</style>
</head>
<body>
  <h1>🗓️ This week</h1>
  <div class="row"><span class="day">MON</span><span class="what">Soccer practice</span><span class="when">5p</span></div>
  <div class="row"><span class="day">TUE</span><span class="what">Taco night</span><span class="when">6:30p</span></div>
  <div class="row"><span class="day">THU</span><span class="what">Book club, ch. 4&ndash;6</span><span class="when">7p</span></div>
  <div class="row"><span class="day">SAT</span><span class="what">Farmers market</span><span class="when">9a</span></div>
</body>
</html>
`;

// Mirrors the payload bundled with the iOS app so a fresh install and a
// remote-refreshed install look identical until this list diverges on
// purpose.
export const EMPTY_STATE_MOCKS: EmptyStateMocksPayload = {
  conversations: [
    {
      id: "soccer-club",
      name: "Dunes Soccer Club",
      emoji: "⚽️",
      messageText:
        "Skipper: need 3 more RSVPs for tomorrow's match — Emily, Ray…",
    },
    {
      id: "fam",
      name: "Fam",
      emoji: "🏡",
      messageText:
        "Mealplanner: this week's dinner plan is ready — taco Tuesday is confirmed",
    },
    {
      id: "book-club",
      name: "Book Club",
      emoji: "📚",
      messageText:
        "Bookworm: reminder — we're discussing chapters 4–6 on Thursday",
    },
    {
      id: "tahoe-trip",
      name: "Tahoe Trip",
      emoji: "🏔️",
      messageText:
        "Trip Planner: cabin booked! I made a packing list for everyone",
    },
  ],
  stuffs: [
    {
      id: "dinner-suggestion",
      title: "Dinner suggestion",
      emoji: "🍴",
      html: DINNER_HTML,
    },
    {
      id: "packing-list",
      title: "Packing list",
      emoji: "🎒",
      html: PACKING_HTML,
    },
    {
      id: "week-plan",
      title: "Weekly plan",
      emoji: "🗓️",
      html: WEEK_PLAN_HTML,
    },
  ],
};
