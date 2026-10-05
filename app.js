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
  logo: (abbrev) => `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`,
};

/**
 * Собственный Cloudflare Worker, проксирующий запросы к API NHL.
 * API NHL не отдаёт CORS-заголовки, поэтому браузер блокирует прямые запросы
 * (например, с GitHub Pages). Все запросы идут в виде:
 *   WORKER_URL?url=<закодированный оригинальный URL>
 */
const WORKER_URL = 'https://nhl-proxy.vikronkirov.workers.dev/';

/** Оборачивает URL API NHL в запрос к воркеру. */
const viaWorker = (url) => `${WORKER_URL}?url=${encodeURIComponent(url)}`;

const MAX_ATTEMPTS = 2; // одна повторная попытка при временном сбое
const TOP_SCORERS_COUNT = 10;
const REQUEST_TIMEOUT_MS = 10000;
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
};

/* ---------- Утилиты ---------- */

/** Экранирование строк перед вставкой в HTML (данные приходят извне). */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

/** Один запрос с таймаутом и проверкой HTTP-статуса, возвращает JSON. */
async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Единая точка загрузки JSON из API NHL: каждый запрос идёт через воркер.
 * @param {string} url       исходный URL API NHL (без прокси)
 * @param {Function} validate необязательная проверка структуры ответа;
 *                            если она бросает ошибку — запрос повторяется
 */
async function fetchJson(url, validate = () => {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await fetchOnce(viaWorker(url));
      validate(data);
      return data;
    } catch (error) {
      lastError = error;
      console.warn(`Запрос через воркер не удался (попытка ${attempt}/${MAX_ATTEMPTS}):`, error);
    }
  }
  throw lastError;
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

/** Таблицы лиги: возвращает нормализованный массив из 32 команд и id сезона. */
async function loadStandings() {
  const data = await fetchJson(API.standings, (d) => {
    if (!Array.isArray(d?.standings) || !d.standings.length) {
      throw new Error('Пустой ответ турнирной таблицы');
    }
  });
  return {
    teams: data.standings.map(normalizeTeam),
    seasonId: data.standings[0].seasonId,
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
  const { data } = await fetchJson(`${API.skaterSummary}?${params}`, (d) => {
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
  const { points } = await fetchJson(`${API.leaders}?categories=points&limit=${TOP_SCORERS_COUNT}`, (d) => {
    if (!Array.isArray(d?.points)) throw new Error('Некорректный ответ лидеров');
  });
  return Promise.all(points.map(async (p) => {
    const landing = await fetchJson(API.player(p.id));
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

function setLoading(isLoading) {
  dom.loader.classList.toggle('is-hidden', !isLoading);
  dom.refreshBtn.disabled = isLoading;
}

function showError(message) {
  dom.errorText.textContent = message;
  dom.errorBanner.hidden = false;
}

function seasonLabel(seasonId) {
  const s = String(seasonId);
  return `Регулярный чемпионат ${s.slice(0, 4)}/${s.slice(4)}`;
}

/** Главная функция: загрузка → отрисовка. */
let isLoading = false;
async function refresh({ silent = false } = {}) {
  if (isLoading) return;
  isLoading = true;
  if (!silent) setLoading(true);
  dom.errorBanner.hidden = true;

  try {
    // 1. Турнирные таблицы (блоки 1–3)
    const { teams, seasonId } = await loadStandings();
    teams.forEach((t) => teamsByAbbrev.set(t.abbrev, t));
    renderTournament(teams);
    renderConference(dom.eastBody, teams, 'E');
    renderConference(dom.westBody, teams, 'W');
    dom.seasonLabel.textContent = seasonLabel(seasonId);
    setLoading(false); // таблицы готовы — не заставляем ждать загрузку бомбардиров

    // 2. Бомбардиры (блок 4) — отдельная обработка ошибки, чтобы не ломать таблицы
    try {
      renderScorers(await loadScorers(seasonId));
      dom.scorersError.hidden = true;
    } catch (scorersError) {
      console.error(scorersError);
      dom.scorersError.hidden = false;
    }

    dom.updatedAt.textContent = `Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
  } catch (error) {
    console.error(error);
    const reason = error.name === 'AbortError' ? 'Превышено время ожидания ответа.' : 'API NHL недоступно.';
    showError(`${reason} Проверьте соединение и попробуйте снова.`);
  } finally {
    isLoading = false;
    setLoading(false);
  }
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
  cachedJson(API.clubSchedule(abbrev), (d) => { if (!Array.isArray(d?.games)) throw new Error('bad schedule'); })
    .then((data) => { if (token === modal.token) fillSchedule(team, data.games); })
    .catch((e) => {
      console.error(e);
      ['form', 'results', 'next'].forEach((s) => slotError(s, 'Не удалось загрузить расписание.'));
    });

  cachedJson(API.clubStats(abbrev), (d) => { if (!Array.isArray(d?.skaters)) throw new Error('bad stats'); })
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
    const player = await cachedJson(API.player(id), (d) => { if (!d?.firstName) throw new Error('bad player'); });
    if (token !== modal.token) return;       // окно уже закрыли или открыли другое
    showModal(playerHtml(player, backTo));
  } catch (error) {
    console.error(error);
    if (token === modal.token) showModal(modalErrorHtml('Не удалось загрузить карточку игрока.'));
  }
}

/* ---------- Обработчики событий окна ---------- */

/** Клик (или Enter/Space) по кликабельному элементу: команда или игрок. */
function handleActivate(event) {
  const teamEl = event.target.closest('[data-team]');
  const playerEl = event.target.closest('[data-player]');
  if (!teamEl && !playerEl) return false;

  if (playerEl) {
    // Если игрок выбран внутри окна команды — запоминаем, куда вернуться
    const fromTeam = !modal.root.hidden && modal.body.contains(playerEl)
      ? modal.body.querySelector('[data-current-team]')?.dataset.currentTeam ?? '' : '';
    openPlayer(playerEl.dataset.player, { backTo: fromTeam });
  } else {
    openTeam(teamEl.dataset.team);
  }
  return true;
}

// Таблицы страницы (делегирование: строки перерисовываются при обновлении данных)
const main = $('main');
main.addEventListener('click', handleActivate);
main.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[role="button"]')) {
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

// Не показываем «битую» картинку, если фото игрока не загрузилось
modal.body.addEventListener('error', (e) => {
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

/* ---------- Запуск ---------- */

dom.retryBtn.addEventListener('click', () => refresh());
dom.refreshBtn.addEventListener('click', () => refresh());

refresh();
// Тихое автообновление, пока вкладка открыта
setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, AUTO_REFRESH_MS);
