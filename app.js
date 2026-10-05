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
});

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

/** Блок 1: мини-лидерборд участников. */
function renderTournament(teams) {
  const ours = teams
    .filter((t) => PARTICIPANTS[t.abbrev])
    .sort(compareByNhlTiebreak);

  dom.tournamentBody.innerHTML = ours.map((t, i) => `
    <tr>
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
    <tr class="${PARTICIPANTS[t.abbrev] ? 'is-ours' : ''}">
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
    <tr class="${PARTICIPANTS[p.team] ? 'is-ours' : ''}">
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

/* ---------- Запуск ---------- */

dom.retryBtn.addEventListener('click', () => refresh());
dom.refreshBtn.addEventListener('click', () => refresh());

refresh();
// Тихое автообновление, пока вкладка открыта
setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, AUTO_REFRESH_MS);
