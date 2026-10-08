/* sports-dashboard build: ovi+recent+boxscore 2026-10-08 16:16:10*/
/* ==========================================================================
   Дружеский турнир NHL — клиентская логика
   Все запросы выполняются прямо в браузере (без бэкенда).
   ========================================================================== */

'use strict';

/* ---------- Конфигурация ---------- */

/** Участники турнира: ключ — аббревиатура команды в API NHL. */
const PARTICIPANTS = {
  TBL: 'Сергей',   // Tampa Bay Lightning
  WSH: 'Михаил',   // Washington Capitals
  MTL: 'Виталий',  // Montreal Canadiens
  CAR: 'Алексей',  // Carolina Hurricanes
  MIN: 'Антон',    // Minnesota Wild
};

const API = {
  standings: 'https://api-web.nhle.com/v1/standings/now',
  // Основной источник бомбардиров: сводная статистика с G, A, GP и сортировкой по очкам
  skaterSummary: 'https://api.nhle.com/stats/rest/en/skater/summary',
  // Запасной вариант: лидеры по очкам + карточки игроков
  leaders: 'https://api-web.nhle.com/v1/skater-stats-leaders/current',
  player: (id) => `https://api-web.nhle.com/v1/player/${id}/landing`,
  // Расписание/результаты клуба за сезон и статистика игроков клуба (для окна команды)
  clubSchedule: (abbrev) => `https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/now`,
  clubStats: (abbrev) => `https://api-web.nhle.com/v1/club-stats/${abbrev}/now`,
  // Счёт матчей за день (score/now) и за конкретную дату (score/YYYY-MM-DD)
  scoreNow: 'https://api-web.nhle.com/v1/score/now',
  scoreDate: (date) => `https://api-web.nhle.com/v1/score/${date}`,
  // Детальная карточка матча: голы по периодам + SOG команд
  gameLanding: (id) => `https://api-web.nhle.com/v1/gamecenter/${id}/landing`,
  gameBoxscore: (id) => `https://api-web.nhle.com/v1/gamecenter/${id}/boxscore`,
  logo: (abbrev) => `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`,
};

/** ID Александра Овечкина и абсолютный рекорд Гретцки (регулярка 894 + плей-офф 122 = 1016). */
const OVECHKIN_ID = 8471214;
const GRETZKY_REG_GOALS = 894;
const GRETZKY_ABS_GOALS = 1016;
const RECENT_GAMES_LIMIT = 12;
const STRENGTH_RU = { ev: 'равн.', pp: 'бол-во', sh: 'мен-во', en: 'пустые' };

/**
 * Источник данных для NBA и Лиги чемпионов — публичное API ESPN (ключ не нужен).
 * Запросы идут через тот же воркер, что и для NHL (см. viaWorker).
 */
const ESPN = {
  // Таблица НБА: season — год окончания сезона (2027 = 2026-27), seasontype=2 — регулярный сезон
  nbaStandings: (year) =>
    `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=${year}&seasontype=2`,
  // Лучшие игроки НБА по среднему количеству очков за игру
  nbaLeaders: (year) =>
    'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?' +
    new URLSearchParams({ limit: '10', sort: 'offensive.avgPoints:desc', season: String(year), seasontype: '2' }),
  // Общая таблица этапа лиги Лиги чемпионов (текущий сезон)
  uclStandings: 'https://site.api.espn.com/apis/v2/sports/soccer/uefa.champions/standings',
  // Лидеры по голам этапа лиги; в ответе только ссылки на игроков, поэтому имена берём отдельно
  uclLeaders: (year) =>
    `https://sports.core.api.espn.com/v2/sports/soccer/leagues/uefa.champions/seasons/${year}/types/1/leaders`,
  uclAthlete: (year, id) =>
    `https://sports.core.api.espn.com/v2/sports/soccer/leagues/uefa.champions/seasons/${year}/athletes/${id}`,
};

const LEAGUE_STORAGE_KEY = 'sportsHub.activeLeague';

/**
 * Собственный Cloudflare Worker, проксирующий запросы к внешним API (NHL, ESPN).
 * Эти API не отдают CORS-заголовки, поэтому браузер блокирует прямые запросы
 * (например, с GitHub Pages). Все запросы идут в виде:
 *   WORKER_URL?url=<закодированный оригинальный URL>
 */
const WORKER_URL = 'https://nhl-proxy.vikronkirov.workers.dev/';

/** Оборачивает URL API NHL в запрос к воркеру. */
const viaWorker = (url) => `${WORKER_URL}?url=${encodeURIComponent(url)}`;

const TOP_SCORERS_COUNT = 10;
const AUTO_REFRESH_MS = 2 * 60 * 1000;

/* ---------- DOM ---------- */

const $ = (selector) => document.querySelector(selector);

const dom = {
  loader: $('#loader'),
  errorBanner: $('#error-banner'),
  errorText: $('#error-text'),
  retryBtn: $('#retry-btn'),
  refreshBtn: $('#refresh-btn'),
  updatedAt: $('#updated-at'),
  seasonLabel: $('#season-label'),
  tournamentBody: $('#tournament-table tbody'),
  eastBody: $('#east-table tbody'),
  westBody: $('#west-table tbody'),
  scorersBody: $('#scorers-table tbody'),
  scorersError: $('#scorers-error'),
  oviContent: $('#ovi-content'),
  oviError: $('#ovi-error'),
  recentGames: $('#recent-games'),
  recentError: $('#recent-error'),
  // NBA
  nbaEastBody: $('#nba-east-table tbody'),
  nbaWestBody: $('#nba-west-table tbody'),
  nbaScorersBody: $('#nba-scorers-table tbody'),
  nbaScorersError: $('#nba-scorers-error'),
  nbaNote: $('#nba-note'),
  // Лига чемпионов
  uclBody: $('#ucl-table tbody'),
  uclScorersBody: $('#ucl-scorers-table tbody'),
  uclScorersError: $('#ucl-scorers-error'),
  uclNote: $('#ucl-note'),
};

/* ---------- Утилиты ---------- */

/** Экранирование строк перед вставкой в HTML (данные приходят извне). */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

/**
 * JSON по прямому адресу, без искусственного таймаута.
 * Для кликов по матчу и игроку адрес уже обёрнут в viaWorker.
 */
async function fetchJson(url, validate = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  validate(data);
  return data;
}

/** Главная страница: один пакет standings + ovechkin + schedule. */
function fetchHomeBundle() {
  return fetchJson(WORKER_URL, (data) => {
    if (!data || typeof data !== 'object') throw new Error('Пустой ответ воркера');
  });
}

/** Разница шайб со знаком и цветом. */
function formatDiff(diff) {
  const cls = diff > 0 ? 'diff-pos' : diff < 0 ? 'diff-neg' : '';
  const text = diff > 0 ? `+${diff}` : String(diff);
  return `<span class="${cls}">${text}</span>`;
}

/** Команда: логотип + название (+ бейдж участника, если это наша команда). */
function teamCell(abbrev, name, withBadge) {
  const owner = PARTICIPANTS[abbrev];
  const badge = withBadge && owner ? ` <span class="badge">${esc(owner)}</span>` : '';
  return `
    <span class="team">
      <img src="${esc(API.logo(abbrev))}" alt="" loading="lazy" width="28" height="28">
      <span class="team-name">${esc(name)}</span>${badge}
    </span>`;
}

/* ---------- Подготовка данных ---------- */

/** Приводит запись API к плоскому удобному объекту. */
const normalizeTeam = (t) => ({
  abbrev: t.teamAbbrev.default,
  name: t.teamName.default,
  conference: t.conferenceAbbrev,        // 'E' или 'W'
  conferenceRank: t.conferenceSequence,
  gp: t.gamesPlayed,
  wins: t.wins,
  losses: t.losses,
  otLosses: t.otLosses,
  points: t.points,
  diff: t.goalDifferential,
  regWins: t.regulationWins,              // RW
  regOtWins: t.regulationPlusOtWins,      // ROW
  raw: t,                                 // полная запись API — нужна для окна команды
});

/** Команды по аббревиатуре (заполняется после загрузки таблиц, нужен окну команды). */
const teamsByAbbrev = new Map();

/**
 * Тай-брейки NHL при равенстве очков:
 * меньше игр → больше побед в основное время (RW) → RW + OT (ROW) →
 * больше побед → лучшая разница шайб.
 */
function compareByNhlTiebreak(a, b) {
  return (
    b.points - a.points ||
    a.gp - b.gp ||
    b.regWins - a.regWins ||
    b.regOtWins - a.regOtWins ||
    b.wins - a.wins ||
    b.diff - a.diff
  );
}

/* ---------- Отрисовка ---------- */

/** Атрибуты кликабельной строки команды (открывает модальное окно). */
function teamRowAttrs(t, extraClass = '') {
  return `class="clickable ${extraClass}" data-team="${esc(t.abbrev)}" tabindex="0" ` +
    `role="button" aria-label="Подробнее о команде ${esc(t.name)}"`;
}

/** Блок 1: мини-лидерборд участников. */
function renderTournament(teams) {
  const ours = teams
    .filter((t) => PARTICIPANTS[t.abbrev])
    .sort(compareByNhlTiebreak);

  dom.tournamentBody.innerHTML = ours.map((t, i) => `
    <tr ${teamRowAttrs(t)}>
      <td class="num"><span class="place place--${i + 1}">${i + 1}</span></td>
      <td><strong>${esc(PARTICIPANTS[t.abbrev])}</strong></td>
      <td>${teamCell(t.abbrev, t.name, false)}</td>
      <td class="num">${t.gp}</td>
      <td class="num pts">${t.points}</td>
    </tr>`).join('');
}

/** Блоки 2 и 3: таблица одной конференции. */
function renderConference(tbody, teams, conference) {
  const rows = teams
    .filter((t) => t.conference === conference)
    .sort((a, b) => a.conferenceRank - b.conferenceRank);

  tbody.innerHTML = rows.map((t) => `
    <tr ${teamRowAttrs(t, PARTICIPANTS[t.abbrev] ? 'is-ours' : '')}>
      <td class="num">${t.conferenceRank}</td>
      <td>${teamCell(t.abbrev, t.name, true)}</td>
      <td class="num">${t.gp}</td>
      <td class="num">${t.wins}</td>
      <td class="num">${t.losses}</td>
      <td class="num">${t.otLosses}</td>
      <td class="num pts">${t.points}</td>
      <td class="num">${formatDiff(t.diff)}</td>
    </tr>`).join('');
}

/** Блок 4: топ бомбардиров. */
function renderScorers(players) {
  if (!players.length) {
    dom.scorersBody.innerHTML = '<tr><td class="empty" colspan="7">Пока нет данных о бомбардирах.</td></tr>';
    return;
  }

  dom.scorersBody.innerHTML = players.map((p, i) => `
    <tr class="clickable ${PARTICIPANTS[p.team] ? 'is-ours' : ''}" data-player="${esc(p.id)}"
        tabindex="0" role="button" aria-label="Подробнее об игроке ${esc(p.name)}">
      <td class="num">${i + 1}</td>
      <td>${esc(p.name)}</td>
      <td>${teamCell(p.team, p.team, true)}</td>
      <td class="num">${p.gp}</td>
      <td class="num">${p.goals}</td>
      <td class="num">${p.assists}</td>
      <td class="num pts">${p.points}</td>
    </tr>`).join('');
}

/* ---------- Загрузка данных ---------- */

/** Таблицы лиги из уже полученного пакета воркера (без отдельного запроса). */
function teamsFromStandings(data) {
  const rows = data?.standings;
  if (!Array.isArray(rows) || !rows.length) return null;
  return {
    teams: rows.map(normalizeTeam),
    seasonId: rows[0].seasonId,
  };
}

/** Топ-10 бомбардиров (основной источник — stats API). */
async function loadScorersPrimary(seasonId) {
  const sort = JSON.stringify([
    { property: 'points', direction: 'DESC' },
    { property: 'goals', direction: 'DESC' },
    { property: 'assists', direction: 'DESC' },
  ]);
  const params = new URLSearchParams({
    limit: String(TOP_SCORERS_COUNT),
    start: '0',
    sort,
    cayenneExp: `seasonId=${seasonId} and gameTypeId=2`, // gameTypeId=2 — регулярный чемпионат
  });
  const { data } = await fetchJson(viaWorker(`${API.skaterSummary}?${params}`), (d) => {
    if (!Array.isArray(d?.data)) throw new Error('Некорректный ответ статистики игроков');
  });

  return data.map((p) => ({
    id: p.playerId,
    name: p.skaterFullName,
    // У обменянных игроков может быть несколько команд ("NYR,TBL") — берём последнюю
    team: String(p.teamAbbrevs).split(',').pop().trim(),
    gp: p.gamesPlayed,
    goals: p.goals,
    assists: p.assists,
    points: p.points,
  }));
}

/** Запасной путь: лидеры по очкам + статистика каждого игрока из его карточки. */
async function loadScorersFallback() {
  const { points } = await fetchJson(viaWorker(`${API.leaders}?categories=points&limit=${TOP_SCORERS_COUNT}`), (d) => {
    if (!Array.isArray(d?.points)) throw new Error('Некорректный ответ лидеров');
  });
  return Promise.all(points.map(async (p) => {
    const landing = await fetchJson(viaWorker(API.player(p.id)));
    const season = landing.featuredStats?.regularSeason?.subSeason ?? {};
    return {
      id: p.id,
      name: `${p.firstName.default} ${p.lastName.default}`,
      team: p.teamAbbrev,
      gp: season.gamesPlayed ?? '—',
      goals: season.goals ?? '—',
      assists: season.assists ?? '—',
      points: p.value,
    };
  }));
}

async function loadScorers(seasonId) {
  try {
    return await loadScorersPrimary(seasonId);
  } catch (primaryError) {
    console.warn('Основной источник бомбардиров недоступен, пробуем запасной:', primaryError);
    return loadScorersFallback();
  }
}

/* ---------- Состояние UI ---------- */

function seasonLabel(seasonId) {
  const s = String(seasonId);
  return `Регулярный чемпионат ${s.slice(0, 4)}/${s.slice(4)}`;
}

/* ==========================================================================
   Виджет Овечкина и лента последних матчей
   ========================================================================== */

/**
 * Карточка Овечкина: голы за регулярку + абсолютная гонка (регулярка + плей-офф)
 * к рекорду Гретцки 1016 (894 + 122).
 */
function renderOvechkin(player) {
  const season = player.featuredStats?.regularSeason?.subSeason ?? {};
  const careerReg = player.careerTotals?.regularSeason
    ?? player.featuredStats?.regularSeason?.career
    ?? {};
  const careerPo = player.careerTotals?.playoffs ?? {};

  const regGoals = careerReg.goals ?? 0;
  const poGoals = careerPo.goals ?? 0;
  const absoluteGoals = regGoals + poGoals;
  const seasonGoals = season.goals ?? 0;

  const remaining = Math.max(0, GRETZKY_ABS_GOALS - absoluteGoals);
  const ahead = Math.max(0, absoluteGoals - GRETZKY_ABS_GOALS);
  const broken = absoluteGoals >= GRETZKY_ABS_GOALS;
  const pct = Math.min(100, Math.round((absoluteGoals / GRETZKY_ABS_GOALS) * 1000) / 10);

  const team = player.currentTeamAbbrev ?? 'WSH';
  const name = `${player.firstName?.default ?? 'Alex'} ${player.lastName?.default ?? 'Ovechkin'}`;
  const headshot = player.headshot || '';

  // До рекорда — явный счётчик «осталось N»; после — лидерство
  const chaseLabel = broken
    ? `Абсолютный рекорд побит! +${ahead} к Гретцки (${GRETZKY_ABS_GOALS})`
    : `До абсолютного рекорда Гретцки (регулярка + плей-офф): осталось <strong>${remaining}</strong> ${pluralGoals(remaining)}`;

  dom.oviContent.innerHTML = `
    <div class="ovi__hero">
      <button class="ovi__photo-btn" type="button" data-player="${OVECHKIN_ID}" aria-label="Открыть карточку ${esc(name)}">
        <img class="ovi__photo" src="${esc(headshot)}" alt="" width="112" height="112" data-hide-on-error>
      </button>
      <div class="ovi__intro">
        <div class="ovi__name-row">
          <h3 class="ovi__name">${esc(name)}</h3>
          <span class="badge">#${player.sweaterNumber ?? 8}</span>
        </div>
        <p class="ovi__meta">
          <img class="inline-logo" src="${esc(API.logo(team))}" alt="" width="18" height="18">
          ${esc(player.fullTeamName?.default ?? team)} · ${esc(POSITIONS[player.position] ?? player.position ?? 'ЛН')}
        </p>
        <div class="ovi__goals-row">
          <div class="ovi__goals-big">
            <span class="ovi__goals-num">${absoluteGoals}</span>
            <span class="ovi__goals-label">всего голов (регулярка + плей-офф)</span>
          </div>
          <div class="ovi__goals-split">
            <div><b>${regGoals}</b><span>регулярка</span></div>
            <div><b>${poGoals}</b><span>плей-офф</span></div>
            <div><b>${GRETZKY_ABS_GOALS}</b><span>рекорд Гретцки</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="ovi__chase ${broken ? 'ovi__chase--broken' : ''}">
      <div class="ovi__chase-head">
        <span>${chaseLabel}</span>
        <span class="ovi__chase-pct">${pct}%</span>
      </div>
      <div class="ovi__bar" role="progressbar" aria-valuemin="0" aria-valuemax="${GRETZKY_ABS_GOALS}"
           aria-valuenow="${absoluteGoals}" aria-label="Прогресс к абсолютному рекорду Гретцки">
        <div class="ovi__bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="ovi__chase-scale">
        <span>0</span>
        <span>Овечкин · ${absoluteGoals}</span>
        <span>Гретцки · ${GRETZKY_ABS_GOALS}</span>
      </div>
      <p class="ovi__chase-note">
        Гретцки: ${GRETZKY_REG_GOALS} в регулярке + 122 в плей-офф = ${GRETZKY_ABS_GOALS}.
        Овечкин: ${regGoals} + ${poGoals} = ${absoluteGoals}.
      </p>
    </div>

    <div class="stat-grid ovi__stats">
      <div class="stat"><div class="stat__value">${seasonGoals}</div><div class="stat__label">Голы · сезон</div></div>
      <div class="stat"><div class="stat__value">${dash(careerReg.gamesPlayed)}</div><div class="stat__label">Матчи (рег.)</div></div>
      <div class="stat"><div class="stat__value">${dash(careerReg.assists)}</div><div class="stat__label">Передачи (рег.)</div></div>
      <div class="stat"><div class="stat__value ovi__pts">${dash(careerReg.points)}</div><div class="stat__label">Очки (рег.)</div></div>
      <div class="stat"><div class="stat__value">${dash(careerReg.powerPlayGoals)}</div><div class="stat__label">Гол. в бол-ве</div></div>
      <div class="stat"><div class="stat__value">${dash(season.gamesPlayed)}</div><div class="stat__label">Игр · сезон</div></div>
    </div>`;
}

/** Склонение «гол / гола / голов». */
function pluralGoals(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'гол';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'гола';
  return 'голов';
}

function applyOvechkin(player) {
  if (!player?.firstName && !player?.playerId) return false;
  renderOvechkin(player);
  return true;
}

/** Нормализация матча из /v1/score/{date} в компактный объект для ленты. */
function normalizeScoreGame(g) {
  const period = g.gameOutcome?.lastPeriodType; // REG | OT | SO
  return {
    id: g.id,
    date: g.gameDate,
    state: g.gameState,
    away: {
      abbrev: g.awayTeam.abbrev,
      name: g.awayTeam.name?.default ?? g.awayTeam.abbrev,
      score: g.awayTeam.score ?? 0,
      logo: API.logo(g.awayTeam.abbrev),
    },
    home: {
      abbrev: g.homeTeam.abbrev,
      name: g.homeTeam.name?.default ?? g.homeTeam.abbrev,
      score: g.homeTeam.score ?? 0,
      logo: API.logo(g.homeTeam.abbrev),
    },
    extra: period === 'OT' || period === 'SO' ? period : '',
  };
}

/** Завершённые матчи из data.schedule пакета воркера. Дополнительных запросов нет. */
function gamesFromSchedule(schedule) {
  const games = Array.isArray(schedule) ? schedule : schedule?.games;
  if (!Array.isArray(games)) return [];
  return games
    .filter((g) => g.gameState === 'OFF' || g.gameState === 'FINAL')
    .map(normalizeScoreGame)
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : b.id - a.id))
    .slice(0, RECENT_GAMES_LIMIT);
}

function renderRecentGames(games) {
  if (!games.length) {
    dom.recentGames.innerHTML = '<p class="muted">Пока нет завершённых матчей.</p>';
    return;
  }

  let lastDate = '';
  const parts = [];
  for (const g of games) {
    if (g.date !== lastDate) {
      lastDate = g.date;
      parts.push(`<h3 class="recent-games__day">${fmtDate(g.date)}</h3>`);
    }
    const awayWin = g.away.score > g.home.score;
    const homeWin = g.home.score > g.away.score;
    parts.push(`
      <article class="recent-game clickable" data-game="${esc(g.id)}" tabindex="0" role="button"
               aria-label="Статистика матча ${esc(g.away.abbrev)} — ${esc(g.home.abbrev)}">
        <div class="recent-game__teams">
          <div class="recent-game__team ${awayWin ? 'is-winner' : ''}">
            <img src="${esc(g.away.logo)}" alt="" width="28" height="28" loading="lazy">
            <span>${esc(g.away.abbrev)}</span>
            <strong class="recent-game__score">${g.away.score}</strong>
          </div>
          <div class="recent-game__team ${homeWin ? 'is-winner' : ''}">
            <img src="${esc(g.home.logo)}" alt="" width="28" height="28" loading="lazy">
            <span>${esc(g.home.abbrev)}</span>
            <strong class="recent-game__score">${g.home.score}</strong>
          </div>
        </div>
        <div class="recent-game__status">
          <span class="recent-game__final">Final${g.extra ? `/${g.extra}` : ''}</span>
        </div>
      </article>`);
  }
  dom.recentGames.innerHTML = `<div class="recent-games__grid">${parts.join('')}</div>`;
}

/* ---------- Модальное окно матча ---------- */

const periodTitle = (desc) => {
  if (!desc) return 'Период';
  if (desc.periodType === 'SO') return 'Буллиты';
  if (desc.periodType === 'OT') return `Овертайм${desc.number > 1 ? ` ${desc.number}` : ''}`;
  return `${desc.number}-й период`;
};

function goalRowHtml(goal) {
  const scorer = goal.name?.default
    ?? `${goal.firstName?.default ?? ''} ${goal.lastName?.default ?? ''}`.trim();
  const assists = (goal.assists ?? [])
    .map((a) => a.name?.default ?? `${a.firstName?.default ?? ''} ${a.lastName?.default ?? ''}`.trim())
    .filter(Boolean);
  const strength = STRENGTH_RU[goal.strength] ?? goal.strength ?? '';
  const team = goal.teamAbbrev?.default ?? '';
  return `
    <li class="box-goal">
      <img class="box-goal__shot" src="${esc(goal.headshot || '')}" alt="" width="36" height="36" data-hide-on-error>
      <div class="box-goal__body">
        <div class="box-goal__main">
          <strong>${esc(scorer)}</strong>
          <span class="box-goal__team">${esc(team)}</span>
          ${strength ? `<span class="box-goal__str">${esc(strength)}</span>` : ''}
        </div>
        <div class="box-goal__assists">${assists.length ? `ассисты: ${esc(assists.join(', '))}` : 'без ассистентов'}</div>
      </div>
      <div class="box-goal__meta">
        <span class="box-goal__time">${esc(goal.timeInPeriod ?? '')}</span>
        <span class="box-goal__score">${goal.awayScore ?? 0}:${goal.homeScore ?? 0}</span>
      </div>
    </li>`;
}

function gameHtml(landing) {
  const away = landing.awayTeam;
  const home = landing.homeTeam;
  const outcome = landing.gameOutcome?.lastPeriodType
    ?? landing.periodDescriptor?.periodType;
  const finalLabel = `Final${outcome === 'OT' || outcome === 'SO' ? `/${outcome}` : ''}`;
  const periods = landing.summary?.scoring ?? [];

  const scoringHtml = periods.length
    ? periods.map((p) => `
        <section class="modal__section">
          <h3>${esc(periodTitle(p.periodDescriptor))} · ${(p.goals ?? []).length} ${pluralGoals((p.goals ?? []).length)}</h3>
          ${(p.goals ?? []).length
            ? `<ul class="box-goals">${(p.goals ?? []).map(goalRowHtml).join('')}</ul>`
            : '<p class="muted">Голов в периоде не было.</p>'}
        </section>`).join('')
    : '<p class="muted">Протокол голов недоступен.</p>';

  const stars = landing.summary?.threeStars ?? [];
  const starsHtml = stars.length
    ? `<section class="modal__section">
        <h3>Три звезды матча</h3>
        <ul class="box-stars">${stars.map((s) => `
          <li class="box-star">
            <span class="box-star__n">${s.star}</span>
            <img src="${esc(s.headshot || '')}" alt="" width="40" height="40" data-hide-on-error>
            <div>
              <strong>${esc(s.name?.default ?? '')}</strong>
              <div class="muted">${esc(s.teamAbbrev)} · ${s.goals ?? 0}Г ${s.assists ?? 0}П</div>
            </div>
          </li>`).join('')}</ul>
      </section>`
    : '';

  return `
    <header class="modal__head box-head">
      <div class="box-scoreboard">
        <div class="box-side">
          <img src="${esc(API.logo(away.abbrev))}" alt="" width="48" height="48">
          <span>${esc(away.abbrev)}</span>
          <strong>${away.score ?? 0}</strong>
        </div>
        <div class="box-mid">
          <span class="recent-game__final">${finalLabel}</span>
          <span class="muted">${fmtDate(landing.gameDate)}</span>
        </div>
        <div class="box-side box-side--home">
          <strong>${home.score ?? 0}</strong>
          <span>${esc(home.abbrev)}</span>
          <img src="${esc(API.logo(home.abbrev))}" alt="" width="48" height="48">
        </div>
      </div>
    </header>

    <div class="stat-grid">
      ${statTile('Броски (SOG)', `${away.sog ?? '—'} : ${home.sog ?? '—'}`, `${away.abbrev} — ${home.abbrev}`)}
      ${statTile('Счёт', `${away.score ?? 0}:${home.score ?? 0}`, finalLabel)}
      ${statTile('Гости', away.commonName?.default ?? away.abbrev, `SOG ${away.sog ?? '—'}`)}
      ${statTile('Хозяева', home.commonName?.default ?? home.abbrev, `SOG ${home.sog ?? '—'}`)}
    </div>

    <h2 class="modal__title" id="modal-title" hidden>${esc(away.abbrev)} ${away.score ?? 0} — ${home.score ?? 0} ${esc(home.abbrev)}</h2>
    ${scoringHtml}
    ${starsHtml}`;
}

/**
 * Протокол матча. Вызывается только по клику на карточку:
 * при первой загрузке страницы gamecenter/landing и boxscore не запрашиваются.
 */
async function openGame(gameId) {
  const token = ++modal.token;
  modal.retry = () => openGame(gameId);
  showModal(loadingHtml('Загружаем статистику матча…'));

  try {
    const landing = await cachedJson(viaWorker(API.gameLanding(gameId)), (d) => {
      if (!d?.id || !d?.awayTeam || !d?.homeTeam) throw new Error('Некорректный ответ матча');
    });
    // Если в landing нет SOG — подстрахуемся boxscore
    if (landing.awayTeam.sog == null || landing.homeTeam.sog == null) {
      try {
        const box = await cachedJson(viaWorker(API.gameBoxscore(gameId)));
        landing.awayTeam.sog ??= box.awayTeam?.sog;
        landing.homeTeam.sog ??= box.homeTeam?.sog;
        landing.gameOutcome ??= box.gameOutcome;
      } catch (e) {
        console.warn('boxscore недоступен, показываем landing без доп. SOG', e);
      }
    }
    if (token !== modal.token) return;
    showModal(gameHtml(landing));
  } catch (error) {
    console.error(error);
    if (token === modal.token) showModal(modalErrorHtml('Не удалось загрузить статистику матча.'));
  }
}

/** Пустые таблицы, если standings не пришли — остальные блоки при этом живут своей жизнью. */
function renderStandingsFailure() {
  dom.tournamentBody.innerHTML =
    '<tr><td class="empty" colspan="5">Не удалось загрузить турнирную таблицу.</td></tr>';
  const conf = '<tr><td class="empty" colspan="8">Не удалось загрузить таблицу конференции.</td></tr>';
  dom.eastBody.innerHTML = conf;
  dom.westBody.innerHTML = conf;
}

/**
 * Вкладка NHL: ровно один запрос на корень воркера.
 * Протокол матча и карточка игрока здесь не запрашиваются.
 * @param {{ready: Function}} ctx
 * @returns {Promise<{subtitle: string}>}
 */
async function loadNhl(ctx) {
  let subtitle = 'NHL';
  try {
    const bundle = await fetchHomeBundle();
    ctx.ready();

    const table = teamsFromStandings(bundle.standings);
    if (table) {
      table.teams.forEach((t) => teamsByAbbrev.set(t.abbrev, t));
      renderTournament(table.teams);
      renderConference(dom.eastBody, table.teams, 'E');
      renderConference(dom.westBody, table.teams, 'W');
      subtitle = seasonLabel(table.seasonId);
    } else {
      renderStandingsFailure();
    }

    if (applyOvechkin(bundle.ovechkin)) dom.oviError.hidden = true;
    else {
      dom.oviError.hidden = false;
      dom.oviContent.innerHTML = '';
    }

    renderRecentGames(gamesFromSchedule(bundle.schedule));
    dom.recentError.hidden = true;
  } catch (error) {
    console.error(error);
    ctx.ready();
    renderStandingsFailure();
    dom.oviError.hidden = false;
    dom.oviContent.innerHTML = '';
    dom.recentError.hidden = false;
    dom.recentGames.innerHTML = '';
  }

  return { subtitle };
}

/* ==========================================================================
   NBA (данные ESPN)
   ========================================================================== */

/** Словарь статистик записи ESPN: { имя: {value, displayValue} }. */
const espnStats = (entry) => Object.fromEntries(entry.stats.map((s) => [s.name, s]));

/** Логотип команды ESPN (для тёмной темы берём «dark»-вариант, если он есть). */
const espnLogo = (team) =>
  (team.logos?.find((l) => l.rel?.includes('dark')) ?? team.logos?.[0])?.href ?? '';

/** Универсальная ячейка «логотип + название» для лиг ESPN. */
function logoCell(logo, name) {
  const img = logo
    ? `<img src="${esc(logo)}" alt="" loading="lazy" width="28" height="28" data-hide-on-error>`
    : '';
  return `<span class="team">${img}<span class="team-name">${esc(name)}</span></span>`;
}

/**
 * Год окончания сезона НБА, который сейчас актуален: сезон стартует в октябре,
 * поэтому с октября это следующий календарный год (окт 2026 → 2027 = «2026-27»).
 */
function currentNbaSeasonYear(now = new Date()) {
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

const nbaSeasonName = (year) => `${year - 1}-${String(year).slice(2)}`;

/** Разбирает таблицу НБА в { E: [...], W: [...] }, отсортированную по сеяным местам. */
function parseNbaStandings(data) {
  const result = { E: [], W: [] };
  for (const conf of data.children) {
    const key = conf.abbreviation === 'East' ? 'E' : 'W';
    result[key] = conf.standings.entries.map((entry) => {
      const s = espnStats(entry);
      const wins = s.wins?.value ?? 0;
      const losses = s.losses?.value ?? 0;
      return {
        name: entry.team.displayName,
        logo: espnLogo(entry.team),
        seed: s.playoffSeed?.value ?? 99,
        gp: wins + losses,
        wins,
        losses,
        pct: s.winPercent?.displayValue ?? '—',
        gb: s.gamesBehind?.displayValue ?? '—',
        diff: s.pointDifferential?.value ?? 0,
        l10: s['Last Ten Games']?.displayValue ?? '—',
        streak: s.streak?.displayValue ?? '—',
      };
    }).sort((a, b) => a.seed - b.seed || b.wins - a.wins);
  }
  return result;
}

function renderNbaConference(tbody, rows) {
  tbody.innerHTML = rows.map((t, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td>${logoCell(t.logo, t.name)}</td>
      <td class="num">${t.gp}</td>
      <td class="num">${t.wins}</td>
      <td class="num">${t.losses}</td>
      <td class="num pts">${esc(t.pct)}</td>
      <td class="num">${esc(t.gb)}</td>
      <td class="num">${formatDiff(t.diff)}</td>
      <td class="num">${esc(t.l10)}</td>
      <td class="num">${esc(t.streak)}</td>
    </tr>`).join('');
}

/** Загружает таблицу НБА; если регулярный сезон ещё не начался — берёт итоги прошлого. */
async function loadNbaStandings() {
  const validate = (d) => {
    if (!Array.isArray(d?.children) || d.children.length < 2) throw new Error('Пустая таблица НБА');
  };

  let year = currentNbaSeasonYear();
  let table = parseNbaStandings(await fetchJson(viaWorker(ESPN.nbaStandings(year)), validate));
  let fallback = false;

  const gamesPlayed = [...table.E, ...table.W].reduce((sum, t) => sum + t.gp, 0);
  if (gamesPlayed === 0) {
    fallback = true;
    year -= 1;
    table = parseNbaStandings(await fetchJson(viaWorker(ESPN.nbaStandings(year)), validate));
  }
  return { table, year, fallback };
}

/** Лучшие по очкам за игру; если в сезоне ещё нет статистики — прошлый сезон. */
async function loadNbaScorers(year) {
  const validate = (d) => { if (!d || typeof d !== 'object') throw new Error('Пустой ответ НБА'); };

  let usedYear = year;
  let data = await fetchJson(viaWorker(ESPN.nbaLeaders(usedYear)), validate);
  if (!data.athletes?.length) {
    usedYear -= 1;
    data = await fetchJson(viaWorker(ESPN.nbaLeaders(usedYear)), validate);
  }

  // Значения лежат в массивах по категориям; имена статистик описаны в data.categories
  const valueOf = (item, category, stat) => {
    const index = data.categories.find((c) => c.name === category)?.names.indexOf(stat);
    return item.categories.find((c) => c.name === category)?.values?.[index];
  };
  const fixed = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');

  const players = (data.athletes ?? []).map((item) => ({
    name: item.athlete.displayName,
    team: item.athlete.teamShortName ?? '',
    logo: item.athlete.teamLogos?.[0]?.href ?? '',
    gp: valueOf(item, 'general', 'gamesPlayed') ?? '—',
    ppg: fixed(valueOf(item, 'offensive', 'avgPoints')),
    reb: fixed(valueOf(item, 'general', 'avgRebounds')),
    ast: fixed(valueOf(item, 'offensive', 'avgAssists')),
    pts: valueOf(item, 'offensive', 'points') ?? '—',
  }));
  return { players, year: usedYear };
}

function renderNbaScorers(players) {
  dom.nbaScorersBody.innerHTML = players.length
    ? players.map((p, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${esc(p.name)}</td>
        <td>${logoCell(p.logo, p.team)}</td>
        <td class="num">${p.gp}</td>
        <td class="num pts">${p.ppg}</td>
        <td class="num">${p.reb}</td>
        <td class="num">${p.ast}</td>
        <td class="num">${p.pts}</td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="8">Пока нет данных об игроках.</td></tr>';
}

async function loadNba(ctx) {
  const { table, year, fallback } = await loadNbaStandings();
  renderNbaConference(dom.nbaEastBody, table.E);
  renderNbaConference(dom.nbaWestBody, table.W);
  ctx.ready();

  let note = fallback
    ? `Регулярный сезон ${nbaSeasonName(year + 1)} ещё не начался — показаны итоги сезона ${nbaSeasonName(year)}.`
    : '';

  try {
    const scorers = await loadNbaScorers(year);
    renderNbaScorers(scorers.players);
    dom.nbaScorersError.hidden = true;
    // Бывает, что таблица уже текущая, а статистика игроков ещё прошлого сезона
    if (scorers.year !== year) {
      note = `Статистика игроков пока за сезон ${nbaSeasonName(scorers.year)}: в новом сезоне ещё нет сыгранных матчей.`;
    }
  } catch (error) {
    console.error(error);
    dom.nbaScorersError.hidden = false;
  }

  dom.nbaNote.textContent = note;
  dom.nbaNote.hidden = !note;
  return { subtitle: `${fallback ? 'Итоги сезона' : 'Регулярный сезон'} NBA ${nbaSeasonName(year)}` };
}

/* ==========================================================================
   Лига чемпионов УЕФА (данные ESPN)
   ========================================================================== */

/** Зона турнирной таблицы этапа лиги (формат 36 команд). */
const uclZone = (rank) => (rank <= 8 ? 'zone-top' : rank <= 24 ? 'zone-mid' : 'zone-out');

/** Кэш имён игроков: в ответе лидеров только ссылки, имя берётся отдельным запросом. */
const uclPlayerNames = new Map();

function parseUclStandings(data) {
  const entries = data.children?.[0]?.standings?.entries ?? [];
  return entries.map((entry) => {
    const s = espnStats(entry);
    return {
      id: entry.team.id,
      name: entry.team.displayName,
      short: entry.team.shortDisplayName ?? entry.team.displayName,
      logo: espnLogo(entry.team),
      rank: s.rank?.value ?? 99,
      gp: s.gamesPlayed?.value ?? 0,
      wins: s.wins?.value ?? 0,
      draws: s.ties?.value ?? 0,
      losses: s.losses?.value ?? 0,
      gf: s.pointsFor?.value ?? 0,
      ga: s.pointsAgainst?.value ?? 0,
      diff: s.pointDifferential?.value ?? 0,
      points: s.points?.value ?? 0,
    };
  }).sort((a, b) => a.rank - b.rank);
}

function renderUclTable(teams) {
  dom.uclBody.innerHTML = teams.map((t) => `
    <tr class="${uclZone(t.rank)}">
      <td class="num">${t.rank}</td>
      <td>${logoCell(t.logo, t.name)}</td>
      <td class="num">${t.gp}</td>
      <td class="num">${t.wins}</td>
      <td class="num">${t.draws}</td>
      <td class="num">${t.losses}</td>
      <td class="num">${t.gf}:${t.ga}</td>
      <td class="num">${formatDiff(t.diff)}</td>
      <td class="num pts">${t.points}</td>
    </tr>`).join('');
}

/** Имя игрока по ссылке ESPN; при сбое показываем запасной вариант, а не роняем всю таблицу. */
async function uclPlayerName(year, id) {
  if (uclPlayerNames.has(id)) return uclPlayerNames.get(id);
  try {
    const athlete = await fetchJson(viaWorker(ESPN.uclAthlete(year, id)), (d) => { if (!d?.displayName) throw new Error('bad athlete'); });
    uclPlayerNames.set(id, athlete.displayName);
    return athlete.displayName;
  } catch (error) {
    console.warn(`Не удалось получить имя игрока ${id}:`, error);
    return `Игрок #${id}`;
  }
}

async function loadUclScorers(year, teams) {
  const data = await fetchJson(viaWorker(ESPN.uclLeaders(year)), (d) => {
    if (!Array.isArray(d?.categories)) throw new Error('Некорректный ответ лидеров ЛЧ');
  });
  const goals = data.categories.find((c) => c.name === 'goalsLeaders')?.leaders ?? [];
  const teamsById = new Map(teams.map((t) => [t.id, t]));

  const top = goals.map((l) => {
    // «M: 1, G: 3: A: 0» — матчи, голы, передачи
    const [, matches = 0, g = 0, a = 0] = /M:\s*(\d+).*?G:\s*(\d+).*?A:\s*(\d+)/.exec(l.shortDisplayValue ?? '') ?? [];
    return {
      id: /athletes\/(\d+)/.exec(l.athlete?.$ref ?? '')?.[1],
      teamId: /teams\/(\d+)/.exec(l.team?.$ref ?? '')?.[1],
      matches: Number(matches),
      goals: Number(g) || l.value || 0,
      assists: Number(a),
    };
  })
    .filter((p) => p.id)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.matches - b.matches)
    .slice(0, TOP_SCORERS_COUNT);

  const names = await Promise.all(top.map((p) => uclPlayerName(year, p.id)));
  return top.map((p, i) => {
    const team = teamsById.get(p.teamId);
    return { ...p, name: names[i], teamName: team?.short ?? '—', teamLogo: team?.logo ?? '' };
  });
}

function renderUclScorers(players) {
  dom.uclScorersBody.innerHTML = players.length
    ? players.map((p, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${esc(p.name)}</td>
        <td>${logoCell(p.teamLogo, p.teamName)}</td>
        <td class="num">${p.matches}</td>
        <td class="num pts">${p.goals}</td>
        <td class="num">${p.assists}</td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="6">Пока никто не забил.</td></tr>';
}

async function loadUcl(ctx) {
  const data = await fetchJson(viaWorker(ESPN.uclStandings), (d) => {
    if (!d?.children?.[0]?.standings?.entries?.length) throw new Error('Пустая таблица Лиги чемпионов');
  });
  const teams = parseUclStandings(data);
  renderUclTable(teams);
  ctx.ready();

  const year = data.season?.year ?? data.children[0].standings.season;
  const seasonYears = /\d{4}-\d{2}/.exec(data.season?.displayName ?? '')?.[0] ?? '';
  const started = teams.some((t) => t.gp > 0);
  dom.uclNote.textContent = started ? '' : 'Матчи этапа лиги ещё не сыграны — таблица пока в стартовом состоянии.';
  dom.uclNote.hidden = started;

  try {
    renderUclScorers(await loadUclScorers(year, teams));
    dom.uclScorersError.hidden = true;
  } catch (error) {
    console.error(error);
    dom.uclScorersError.hidden = false;
  }

  return { subtitle: `Лига чемпионов УЕФА ${seasonYears} · этап лиги` };
}

/* ==========================================================================
   Модальные окна: карточка команды и карточка игрока
   ========================================================================== */

const NHL_SITE = 'https://www.nhl.com';
const MODAL_ANIMATION_MS = 220;
const MODAL_CACHE_TTL_MS = 60 * 1000;

const modal = {
  root: $('#modal'),
  body: $('#modal-body'),
  closeBtn: $('#modal-close'),
  token: 0,            // номер текущего открытия: защита от «устаревших» ответов API
  lastFocus: null,     // элемент, на котором был фокус до открытия
  closeTimer: null,
  retry: null,         // функция для кнопки «Повторить»
};

/** Кэш ответов для окон (повторное открытие не дёргает API). */
const modalCache = new Map();
async function cachedJson(url, validate) {
  const hit = modalCache.get(url);
  if (hit && Date.now() - hit.time < MODAL_CACHE_TTL_MS) return hit.data;
  const data = await fetchJson(url, validate);
  modalCache.set(url, { data, time: Date.now() });
  return data;
}

/* ---------- Открытие / закрытие ---------- */

function showModal(html) {
  clearTimeout(modal.closeTimer);
  modal.body.innerHTML = html;
  modal.body.scrollTop = 0;
  modal.body.querySelectorAll('.table-wrap').forEach(watchScroll);  // таблицы внутри окна тоже скроллятся
  if (modal.root.hidden) {
    modal.lastFocus = document.activeElement;
    modal.root.hidden = false;
    void modal.root.offsetWidth;                 // перезапуск CSS-анимации
    document.body.classList.add('modal-open');   // блокируем прокрутку страницы под окном
  }
  modal.root.classList.add('is-open');
  modal.closeBtn.focus({ preventScroll: true });
}

function closeModal() {
  if (modal.root.hidden) return;
  modal.token++;                                 // отменяем незавершённые загрузки
  modal.root.classList.remove('is-open');
  document.body.classList.remove('modal-open');
  modal.closeTimer = setTimeout(() => {
    modal.root.hidden = true;
    modal.body.innerHTML = '';
    modal.lastFocus?.focus?.({ preventScroll: true });
  }, MODAL_ANIMATION_MS);
}

/** Блок с сообщением об ошибке и (опционально) кнопкой повтора. */
const modalErrorHtml = (text, withRetry = true) => `
  <div class="modal__error">
    <p>${esc(text)}</p>
    ${withRetry ? '<button class="btn" type="button" data-retry>Повторить</button>' : ''}
  </div>`;

const loadingHtml = (text = 'Загрузка…') =>
  `<div class="modal__loading"><div class="loader__puck"></div><p>${esc(text)}</p></div>`;

/* ---------- Форматирование ---------- */

const POSITIONS = { C: 'Центрфорвард', L: 'Левый нападающий', R: 'Правый нападающий', D: 'Защитник', G: 'Вратарь' };
const HANDS = { L: 'левый', R: 'правый' };
const CONFERENCES_RU = { Eastern: 'Восточная', Western: 'Западная' };
const DIVISIONS_RU = { Atlantic: 'Атлантический', Metropolitan: 'Столичный', Central: 'Центральный', Pacific: 'Тихоокеанский' };

const dash = (v) => (v === undefined || v === null ? '—' : v);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const percent = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');

/** Дата вида «5 окт» (дата без времени из API трактуется как локальная). */
const fmtDate = (isoDate) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

/** Дата и время начала матча в часовом поясе пользователя. */
const fmtDateTime = (isoUtc) =>
  new Date(isoUtc).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ageFrom(isoDate) {
  const birth = new Date(isoDate);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate())) age--;
  return age;
}

/** Плитка со статистикой. */
const statTile = (label, value, sub = '') => `
  <div class="stat">
    <div class="stat__value">${esc(value)}</div>
    <div class="stat__label">${esc(label)}</div>
    ${sub ? `<div class="stat__sub">${esc(sub)}</div>` : ''}
  </div>`;

const ownerBadge = (abbrev) =>
  PARTICIPANTS[abbrev] ? `<span class="badge">${esc(PARTICIPANTS[abbrev])}</span>` : '';

/* ---------- Окно команды ---------- */

/** Исход матча с точки зрения команды `abbrev`. */
function gameOutcome(game, abbrev) {
  const isHome = game.homeTeam.abbrev === abbrev;
  const mine = isHome ? game.homeTeam : game.awayTeam;
  const opp = isHome ? game.awayTeam : game.homeTeam;
  const period = game.gameOutcome?.lastPeriodType;       // REG | OT | SO
  const extraTime = period === 'OT' || period === 'SO';
  const result = mine.score > opp.score ? 'W' : extraTime ? 'OTL' : 'L';
  return { isHome, mine, opp, result, suffix: extraTime ? period : '' };
}

const isFinished = (g) => g.gameState === 'FINAL' || g.gameState === 'OFF';
const isLive = (g) => g.gameState === 'LIVE' || g.gameState === 'CRIT';
const RESULT_LABEL = { W: 'В', L: 'П', OTL: 'ПО' };   // победа / поражение / поражение в ОТ/буллитах

const resultChip = (result) => `<span class="chip chip--${result}">${RESULT_LABEL[result]}</span>`;

/** Название сайта команды на nhl.com: «Maple Leafs» → /mapleleafs. */
function teamSiteUrl(team) {
  const slug = (team.raw.teamCommonName?.default ?? team.name).toLowerCase().replace(/[^a-z]/g, '');
  return `${NHL_SITE}/${slug}/`;
}

/** Каркас окна: шапка и статистика берутся из таблицы лиги (уже загружена), остальное подгружается. */
function teamBaseHtml(team) {
  const r = team.raw;
  const streakWord = { W: 'побед подряд', L: 'поражений подряд', OT: 'поражений в ОТ подряд' }[r.streakCode];

  return `
    <header class="modal__head">
      <img class="modal__logo" src="${esc(API.logo(team.abbrev))}" alt="" width="72" height="72">
      <div>
        <h2 class="modal__title" id="modal-title" data-current-team="${esc(team.abbrev)}">${esc(team.name)} ${ownerBadge(team.abbrev)}</h2>
        <p class="modal__meta">
          ${esc(CONFERENCES_RU[r.conferenceName] ?? r.conferenceName)} конференция, #${r.conferenceSequence} ·
          ${esc(DIVISIONS_RU[r.divisionName] ?? r.divisionName)} дивизион, #${r.divisionSequence} ·
          #${r.leagueSequence} в лиге
        </p>
        <a class="modal__link" href="${esc(teamSiteUrl(team))}" target="_blank" rel="noopener noreferrer">
          Сайт команды на NHL.com ↗
        </a>
      </div>
    </header>

    <div class="stat-grid">
      ${statTile('Очки', r.points, `${percent(r.pointPctg)} от максимума`)}
      ${statTile('Рекорд W-L-OT', `${r.wins}-${r.losses}-${r.otLosses}`, `${r.gamesPlayed} игр`)}
      ${statTile('Дома', `${r.homeWins}-${r.homeLosses}-${r.homeOtLosses}`, `${r.homePoints} очк.`)}
      ${statTile('В гостях', `${r.roadWins}-${r.roadLosses}-${r.roadOtLosses}`, `${r.roadPoints} очк.`)}
      ${statTile('Последние 10', `${r.l10Wins}-${r.l10Losses}-${r.l10OtLosses}`, `${r.l10Points} очк.`)}
      ${statTile('Серия', r.streakCode ? `${r.streakCode}${r.streakCount}` : '—', r.streakCode ? streakWord : '')}
      ${statTile('Голы З:П', `${r.goalFor}:${r.goalAgainst}`, `разница ${signed(r.goalDifferential)}`)}
      ${statTile('Победы в осн. время', r.regulationWins, `с овертаймом: ${r.regulationPlusOtWins}`)}
    </div>

    <section class="modal__section"><h3>Форма (последние 5 матчей)</h3><div data-slot="form">${loadingHtml()}</div></section>
    <section class="modal__section"><h3>Последние результаты</h3><div data-slot="results">${loadingHtml()}</div></section>
    <section class="modal__section"><h3>Ближайшие матчи</h3><div data-slot="next">${loadingHtml()}</div></section>
    <section class="modal__section"><h3>Лучшие игроки команды</h3><div data-slot="leaders">${loadingHtml()}</div></section>`;
}

/** Заполняет секции «Форма», «Результаты», «Ближайшие матчи» по расписанию клуба. */
function fillSchedule(team, games) {
  const regular = games.filter((g) => g.gameType === 2);
  const played = regular.filter(isFinished);
  const last5 = played.slice(-5);
  const upcoming = regular.filter((g) => !isFinished(g)).slice(0, 3);

  const slot = (name) => modal.body.querySelector(`[data-slot="${name}"]`);

  // Форма: от старых матчей к новым
  slot('form').innerHTML = last5.length
    ? `<div class="form">${last5.map((g) => resultChip(gameOutcome(g, team.abbrev).result)).join('')}</div>`
    : '<p class="muted">Сыгранных матчей в регулярном чемпионате пока нет.</p>';

  // Результаты: от новых к старым
  slot('results').innerHTML = last5.length
    ? `<ul class="games">${[...last5].reverse().map((g) => {
        const o = gameOutcome(g, team.abbrev);
        return `
          <li class="game">
            <span class="game__date">${fmtDate(g.gameDate)}</span>
            <span class="game__where">${o.isHome ? 'дома' : 'в гостях'}</span>
            <span class="game__opp"><img src="${esc(API.logo(o.opp.abbrev))}" alt="" width="22" height="22">${esc(o.opp.placeName.default)}</span>
            <span class="game__score">${o.mine.score}:${o.opp.score}${o.suffix ? ` <small>${o.suffix}</small>` : ''}</span>
            ${resultChip(o.result)}
          </li>`;
      }).join('')}</ul>`
    : '<p class="muted">Пока нет данных.</p>';

  // Ближайшие матчи
  slot('next').innerHTML = upcoming.length
    ? `<ul class="games">${upcoming.map((g) => {
        const o = gameOutcome({ ...g, gameOutcome: undefined }, team.abbrev);
        const status = isLive(g)
          ? `<span class="live">LIVE ${o.mine.score ?? 0}:${o.opp.score ?? 0}</span>`
          : fmtDateTime(g.startTimeUTC);
        return `
          <li class="game">
            <span class="game__date game__date--wide">${status}</span>
            <span class="game__where">${o.isHome ? 'дома' : 'в гостях'}</span>
            <span class="game__opp"><img src="${esc(API.logo(o.opp.abbrev))}" alt="" width="22" height="22">${esc(o.opp.placeName.default)}</span>
          </li>`;
      }).join('')}</ul>`
    : '<p class="muted">Расписание ближайших матчей недоступно.</p>';
}

/** Топ-3 игрока команды по очкам. */
function fillLeaders(stats) {
  const top = [...stats.skaters]
    .filter((p) => p.gamesPlayed > 0)
    .sort((a, b) => b.points - a.points || b.goals - a.goals)
    .slice(0, 3);

  modal.body.querySelector('[data-slot="leaders"]').innerHTML = top.length
    ? `<ul class="leaders">${top.map((p) => `
        <li class="leader clickable" data-player="${esc(p.playerId)}" tabindex="0" role="button">
          <img src="${esc(p.headshot)}" alt="" width="40" height="40" data-hide-on-error>
          <span class="leader__name">${esc(p.firstName.default)} ${esc(p.lastName.default)}</span>
          <span class="leader__stats">${p.goals} Г · ${p.assists} П · <b>${p.points} О</b></span>
        </li>`).join('')}</ul>`
    : '<p class="muted">Пока никто не набрал очков.</p>';
}

function openTeam(abbrev) {
  const team = teamsByAbbrev.get(abbrev);
  if (!team) return;

  const token = ++modal.token;
  modal.retry = () => openTeam(abbrev);
  showModal(teamBaseHtml(team));

  const slotError = (name, text) => {
    if (token !== modal.token) return;
    modal.body.querySelector(`[data-slot="${name}"]`).innerHTML = modalErrorHtml(text);
  };

  // Расписание и статистика грузятся параллельно и независимо друг от друга
  cachedJson(viaWorker(API.clubSchedule(abbrev)), (d) => { if (!Array.isArray(d?.games)) throw new Error('bad schedule'); })
    .then((data) => { if (token === modal.token) fillSchedule(team, data.games); })
    .catch((e) => {
      console.error(e);
      ['form', 'results', 'next'].forEach((s) => slotError(s, 'Не удалось загрузить расписание.'));
    });

  cachedJson(viaWorker(API.clubStats(abbrev)), (d) => { if (!Array.isArray(d?.skaters)) throw new Error('bad stats'); })
    .then((data) => { if (token === modal.token) fillLeaders(data); })
    .catch((e) => { console.error(e); slotError('leaders', 'Не удалось загрузить статистику игроков.'); });
}

/* ---------- Окно игрока ---------- */

function playerHtml(p, backTo) {
  const season = p.featuredStats?.regularSeason?.subSeason;
  const career = p.featuredStats?.regularSeason?.career;
  const team = p.currentTeamAbbrev;
  const fullName = `${p.firstName.default} ${p.lastName.default}`;
  const born = [p.birthCity?.default, p.birthStateProvince?.default, p.birthCountry].filter(Boolean).join(', ');
  const draft = p.draftDetails
    ? `${p.draftDetails.year}, раунд ${p.draftDetails.round}, №${p.draftDetails.overallPick} (${p.draftDetails.teamAbbrev})`
    : 'не выбирался на драфте';

  const bio = [
    ['Возраст', p.birthDate ? `${ageFrom(p.birthDate)} (${fmtDate(p.birthDate)} ${p.birthDate.slice(0, 4)})` : '—'],
    ['Рост / вес', p.heightInCentimeters ? `${p.heightInCentimeters} см / ${p.weightInKilograms} кг` : '—'],
    ['Родился', born || '—'],
    ['Хват', HANDS[p.shootsCatches] ?? '—'],
    ['Драфт', draft],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');

  const last5 = (p.last5Games ?? []).map((g) => `
    <tr>
      <td>${fmtDate(g.gameDate)}</td>
      <td>${g.homeRoadFlag === 'H' ? 'vs' : '@'} ${esc(g.opponentAbbrev)}</td>
      <td class="num">${g.goals}</td><td class="num">${g.assists}</td>
      <td class="num pts">${g.points}</td><td class="num">${signed(g.plusMinus)}</td>
      <td class="num">${esc(g.toi)}</td>
    </tr>`).join('');

  const profileUrl = p.playerSlug ? `${NHL_SITE}/player/${p.playerSlug}` : '';

  return `
    ${backTo ? `<button class="btn btn--small modal__back" type="button" data-team-back="${esc(backTo)}">← К команде</button>` : ''}
    <header class="modal__head">
      <img class="modal__photo" src="${esc(p.headshot)}" alt="" width="96" height="96" data-hide-on-error>
      <div>
        <h2 class="modal__title" id="modal-title">${esc(fullName)} ${ownerBadge(team)}</h2>
        <p class="modal__meta">
          ${p.sweaterNumber ? `#${p.sweaterNumber} · ` : ''}${esc(POSITIONS[p.position] ?? p.position)} ·
          <img class="inline-logo" src="${esc(API.logo(team))}" alt="" width="18" height="18">
          ${esc(p.fullTeamName?.default ?? team)}
        </p>
        ${profileUrl ? `<a class="modal__link" href="${esc(profileUrl)}" target="_blank" rel="noopener noreferrer">Профиль на NHL.com ↗</a>` : ''}
      </div>
    </header>

    <dl class="bio">${bio}</dl>

    <section class="modal__section">
      <h3>Текущий сезон</h3>
      <div class="stat-grid">
        ${statTile('Игры', dash(season?.gamesPlayed))}
        ${statTile('Голы', dash(season?.goals))}
        ${statTile('Передачи', dash(season?.assists))}
        ${statTile('Очки', dash(season?.points))}
        ${statTile('+/−', season ? signed(season.plusMinus) : '—')}
        ${statTile('Штраф, мин', dash(season?.pim))}
        ${statTile('Голы в большинстве', dash(season?.powerPlayGoals))}
        ${statTile('Броски', dash(season?.shots), season ? `реализация ${percent(season.shootingPctg)}` : '')}
      </div>
    </section>

    <section class="modal__section">
      <h3>Последние 5 матчей</h3>
      ${last5
        ? `<div class="table-wrap"><table class="table table--mini">
            <thead><tr><th>Дата</th><th>Соперник</th><th class="num">Г</th><th class="num">П</th><th class="num">О</th><th class="num">+/−</th><th class="num">Время</th></tr></thead>
            <tbody>${last5}</tbody></table></div>`
        : '<p class="muted">Нет данных о последних матчах.</p>'}
    </section>

    ${career ? `
    <section class="modal__section">
      <h3>Карьера в НХЛ (регулярные чемпионаты)</h3>
      <div class="stat-grid">
        ${statTile('Игры', career.gamesPlayed)}
        ${statTile('Голы', career.goals)}
        ${statTile('Передачи', career.assists)}
        ${statTile('Очки', career.points)}
      </div>
    </section>` : ''}`;
}

async function openPlayer(id, { backTo = '' } = {}) {
  const token = ++modal.token;
  modal.retry = () => openPlayer(id, { backTo });
  showModal(loadingHtml('Загружаем карточку игрока…'));

  try {
    const player = await cachedJson(viaWorker(API.player(id)), (d) => { if (!d?.firstName) throw new Error('bad player'); });
    if (token !== modal.token) return;       // окно уже закрыли или открыли другое
    showModal(playerHtml(player, backTo));
  } catch (error) {
    console.error(error);
    if (token === modal.token) showModal(modalErrorHtml('Не удалось загрузить карточку игрока.'));
  }
}

/* ---------- Обработчики событий окна ---------- */

/** Клик (или Enter/Space) по кликабельному элементу: матч, команда или игрок. */
function handleActivate(event) {
  const gameEl = event.target.closest('[data-game]');
  const teamEl = event.target.closest('[data-team]');
  const playerEl = event.target.closest('[data-player]');
  if (!gameEl && !teamEl && !playerEl) return false;

  if (gameEl) {
    openGame(gameEl.dataset.game);
  } else if (playerEl) {
    // Если игрок выбран внутри окна команды — запоминаем, куда вернуться
    const fromTeam = !modal.root.hidden && modal.body.contains(playerEl)
      ? modal.body.querySelector('[data-current-team]')?.dataset.currentTeam ?? '' : '';
    openPlayer(playerEl.dataset.player, { backTo: fromTeam });
  } else {
    openTeam(teamEl.dataset.team);
  }
  return true;
}

// Таблицы и карточки матчей (делегирование: DOM перерисовывается при обновлении)
const main = $('main');
main.addEventListener('click', handleActivate);
main.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) {
    e.preventDefault();
    handleActivate(e);
  }
});

// Внутри окна: игроки команды, «Назад», «Повторить»
modal.root.addEventListener('click', (e) => {
  // Закрытие: крестик или тёмный фон вокруг окна
  if (e.target === modal.root || e.target.closest('[data-close]')) return closeModal();

  const back = e.target.closest('[data-team-back]');
  if (back) return openTeam(back.dataset.teamBack);
  if (e.target.closest('[data-retry]')) return modal.retry?.();
  handleActivate(e);
});
modal.root.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.leader')) {
    e.preventDefault();
    handleActivate(e);
  }
});

// Не показываем «битую» картинку (фото игрока, логотип), если она не загрузилась
document.addEventListener('error', (e) => {
  if (e.target.matches?.('img[data-hide-on-error]')) e.target.style.visibility = 'hidden';
}, true);

// Esc закрывает окно; Tab не уходит за пределы окна (ловушка фокуса)
document.addEventListener('keydown', (e) => {
  if (modal.root.hidden) return;
  if (e.key === 'Escape') return closeModal();
  if (e.key !== 'Tab') return;

  const focusable = [...modal.root.querySelectorAll('button, a[href], [tabindex="0"]')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ==========================================================================
   Подсказки горизонтальной прокрутки таблиц
   Если таблица шире экрана, край со скрытым содержимым плавно затухает
   (стили — .table-wrap.can-scroll-left/right в style.css).
   ========================================================================== */

const scrollObserver = 'ResizeObserver' in window
  ? new ResizeObserver((entries) => entries.forEach((e) => updateScrollHints(e.target.closest('.table-wrap') ?? e.target)))
  : null;

function updateScrollHints(wrap) {
  const max = wrap.scrollWidth - wrap.clientWidth;
  wrap.classList.toggle('can-scroll-left', wrap.scrollLeft > 4);
  wrap.classList.toggle('can-scroll-right', max > 4 && wrap.scrollLeft < max - 4);
}

/** Подключает подсказки к контейнеру таблицы (повторный вызов безопасен). */
function watchScroll(wrap) {
  if (wrap.dataset.scrollWatched) return;
  wrap.dataset.scrollWatched = '1';
  wrap.addEventListener('scroll', () => updateScrollHints(wrap), { passive: true });
  // Размеры меняются при показе панели вкладки, перерисовке данных и повороте экрана
  scrollObserver?.observe(wrap);
  const table = wrap.querySelector('table');
  if (table) scrollObserver?.observe(table);
  updateScrollHints(wrap);
}

document.querySelectorAll('.table-wrap').forEach(watchScroll);

/** Синхронный пересчёт подсказок для видимых таблиц (после смены вкладки или обновления данных). */
const refreshScrollHints = () =>
  document.querySelectorAll('.panel:not([hidden]) .table-wrap').forEach(updateScrollHints);

/* ==========================================================================
   Вкладки лиг: переключение, ленивая загрузка, запоминание выбора
   ========================================================================== */

/** Описание лиг: вкладка, панель, функция загрузки и собственное состояние. */
const LEAGUES = {
  nhl: { name: 'NHL', load: loadNhl },
  nba: { name: 'NBA', load: loadNba },
  ucl: { name: 'Champions League', load: loadUcl },
};

for (const [key, league] of Object.entries(LEAGUES)) {
  league.tab = $(`#tab-${key}`);
  league.panel = $(`#panel-${key}`);
  league.state = {
    loading: false,   // идёт запрос
    ready: false,     // основные таблицы уже показаны (лоадер можно скрыть)
    silent: false,    // фоновое обновление — без лоадера
    loaded: false,    // данные успешно загружались хотя бы раз
    error: '',
    subtitle: '',
    updatedAt: null,
  };
}

let activeLeague = 'nhl';

/** Читает/пишет localStorage безопасно (может быть недоступен, например в приватном режиме). */
const storage = {
  get() { try { return localStorage.getItem(LEAGUE_STORAGE_KEY); } catch { return null; } },
  set(value) { try { localStorage.setItem(LEAGUE_STORAGE_KEY, value); } catch { /* игнорируем */ } },
};

/** Синхронизирует общие элементы (лоадер, ошибку, подзаголовок) с состоянием активной лиги. */
function syncChrome() {
  const { state } = LEAGUES[activeLeague];
  dom.loader.classList.toggle('is-hidden', !(state.loading && !state.silent && !state.ready));
  dom.refreshBtn.disabled = state.loading && !state.silent;
  dom.errorBanner.hidden = !state.error;
  dom.errorText.textContent = state.error;
  dom.seasonLabel.textContent = state.subtitle || LEAGUES[activeLeague].name;
  dom.updatedAt.textContent = state.updatedAt
    ? `Обновлено: ${state.updatedAt.toLocaleTimeString('ru-RU')}`
    : '';
}

/** Загрузка данных лиги (с защитой от параллельных запросов одной лиги). */
async function refreshLeague(key, { silent = false } = {}) {
  const league = LEAGUES[key];
  const { state } = league;
  if (state.loading) return;

  Object.assign(state, { loading: true, ready: false, silent });
  if (!silent) state.error = '';
  syncChrome();

  try {
    const result = await league.load({
      ready: () => { state.ready = true; syncChrome(); },
    });
    state.loaded = true;
    state.error = '';
    state.subtitle = result.subtitle;
    state.updatedAt = new Date();
  } catch (error) {
    console.error(error);
    state.error = '';
  } finally {
    state.loading = false;
    syncChrome();
  }
}

/** Переключает вкладку: показывает нужную панель и при необходимости подгружает данные. */
function activateLeague(key, { focus = false, persist = true } = {}) {
  if (!LEAGUES[key]) key = 'nhl';
  activeLeague = key;

  for (const [k, league] of Object.entries(LEAGUES)) {
    const isActive = k === key;
    league.tab.setAttribute('aria-selected', String(isActive));
    league.tab.tabIndex = isActive ? 0 : -1;
    league.panel.hidden = !isActive;  // у показанной панели срабатывает CSS-анимация появления
  }
  if (focus) LEAGUES[key].tab.focus();
  if (persist) {
    storage.set(key);
    history.replaceState(null, '', `#${key}`);
  }

  const { state } = LEAGUES[key];
  syncChrome();
  if (!state.loaded && !state.loading) refreshLeague(key);
  // Вернулись на вкладку с устаревшими данными — обновляем в фоне
  else if (state.loaded && Date.now() - state.updatedAt > AUTO_REFRESH_MS) refreshLeague(key, { silent: true });
}

/* ---------- Запуск ---------- */

// Клики и клавиатура (стрелки, Home/End) по вкладкам
for (const [key, league] of Object.entries(LEAGUES)) {
  league.tab.addEventListener('click', () => activateLeague(key));
}
$('.tabs').addEventListener('keydown', (e) => {
  const keys = Object.keys(LEAGUES);
  const index = keys.indexOf(activeLeague);
  const target = {
    ArrowRight: keys[(index + 1) % keys.length],
    ArrowLeft: keys[(index - 1 + keys.length) % keys.length],
    Home: keys[0],
    End: keys[keys.length - 1],
  }[e.key];
  if (target) {
    e.preventDefault();
    activateLeague(target, { focus: true });
  }
});

dom.retryBtn.addEventListener('click', () => refreshLeague(activeLeague));
dom.refreshBtn.addEventListener('click', () => refreshLeague(activeLeague));

// Ручное изменение #hash (кнопки «назад/вперёд», закладки) тоже переключает вкладку
window.addEventListener('hashchange', () => {
  const key = location.hash.slice(1);
  if (LEAGUES[key] && key !== activeLeague) activateLeague(key, { persist: false });
});

// Стартовая вкладка: ссылка с #nba → последняя выбранная (localStorage) → NHL
const hashKey = location.hash.slice(1);
const savedKey = storage.get();
activateLeague(LEAGUES[hashKey] ? hashKey : LEAGUES[savedKey] ? savedKey : 'nhl');

// Тихое автообновление активной вкладки, пока страница открыта
setInterval(() => {
  if (!document.hidden) refreshLeague(activeLeague, { silent: true });
}, AUTO_REFRESH_MS);
