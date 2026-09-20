import { api, ApiError } from './api.js';
import { $, $$, esc, initials, toast } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { historyView, markView } from './views/mark.js';
import { coursesView } from './views/courses.js';
import { peopleView } from './views/people.js';
import { reportsView, settingsView } from './views/reports.js';

/** Every route, with the roles allowed to open it. */
const ROUTES = [
  { path: 'dashboard', title: 'Dashboard',        icon: '▦', roles: ['admin', 'teacher', 'student'], view: dashboardView,
    subtitle: 'An overview of attendance across your courses.' },
  { path: 'mark',      title: 'Take Attendance',  icon: '✓', roles: ['admin', 'teacher'],            view: markView,
    subtitle: 'Mark today’s class in one pass, then save.' },
  { path: 'history',   title: 'Records',          icon: '≡', roles: ['admin', 'teacher', 'student'], view: historyView,
    subtitle: 'Browse and filter individual attendance records.' },
  { path: 'courses',   title: 'Courses',          icon: '▤', roles: ['admin', 'teacher', 'student'], view: coursesView,
    subtitle: 'Courses, their teachers and their rosters.' },
  { path: 'people',    title: 'People',           icon: '◎', roles: ['admin', 'teacher'],            view: peopleView,
    subtitle: 'Students, teachers and administrator accounts.' },
  { path: 'reports',   title: 'Reports',          icon: '◔', roles: ['admin', 'teacher'],            view: reportsView,
    subtitle: 'Per-student attendance rates, with CSV export.' },
  { path: 'settings',  title: 'My Account',       icon: '⚙', roles: ['admin', 'teacher', 'student'], view: settingsView,
    subtitle: 'Your details and password.' }
];

const state = { user: null };

const loginScreen = $('#login-screen');
const appShell = $('#app-shell');
const viewRoot = $('#view');

/* -------------------------------------------------------------- routing */

/** Parse "#/reports?courseId=3" into { path, params }. */
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path: path || 'dashboard', params: new URLSearchParams(query) };
}

const navigate = (hash) => {
  window.location.hash = hash;
};

function renderNav(role) {
  const { path } = parseHash();

  $('#nav').innerHTML = ROUTES.filter((route) => route.roles.includes(role))
    .map(
      (route) => `
      <a class="nav-link ${route.path === path ? 'active' : ''}" href="#/${route.path}">
        <span class="icon">${route.icon}</span>${esc(route.title)}
      </a>`
    )
    .join('');
}

async function renderRoute() {
  if (!state.user) return;

  const { path, params } = parseHash();
  const route =
    ROUTES.find((candidate) => candidate.path === path && candidate.roles.includes(state.user.role)) ??
    ROUTES[0];

  if (route.path !== path) {
    // The requested route does not exist for this role — fall back quietly.
    navigate(`#/${route.path}`);
    return;
  }

  renderNav(state.user.role);
  $('#view-title').textContent = route.title;
  $('#view-subtitle').textContent = route.subtitle ?? '';
  $('#sidebar').classList.remove('open');
  viewRoot.innerHTML = '<div class="loading">Loading…</div>';

  try {
    await route.view(viewRoot, { user: state.user, params, navigate });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin('Your session has expired. Please sign in again.');
      return;
    }
    viewRoot.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
    console.error(error);
  }
}

/* --------------------------------------------------------------- session */

function showApp(user) {
  state.user = user;

  loginScreen.classList.add('hidden');
  appShell.classList.remove('hidden');

  $('#user-name').textContent = user.name;
  $('#user-role').textContent = user.role;
  $('#user-avatar').textContent = initials(user.name);

  if (!window.location.hash) {
    navigate('#/dashboard');
    return;
  }
  renderRoute();
}

function showLogin(message = '') {
  state.user = null;

  appShell.classList.add('hidden');
  loginScreen.classList.remove('hidden');

  const errorBox = $('#login-error');
  errorBox.textContent = message;
  errorBox.classList.toggle('hidden', !message);
}

/* ---------------------------------------------------------------- events */

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const button = $('#login-submit');
  const errorBox = $('#login-error');

  errorBox.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Signing in…';

  try {
    const { user } = await api.post('/auth/login', {
      email: $('#login-email').value.trim(),
      password: $('#login-password').value
    });
    $('#login-password').value = '';
    showApp(user);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$$('[data-demo]').forEach((button) =>
  button.addEventListener('click', () => {
    $('#login-email').value = button.dataset.demo;
    $('#login-password').value = 'password123';
    $('#login-password').focus();
  })
);

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api.post('/auth/logout');
  } catch {
    // Signing out locally matters more than the server acknowledging it.
  }
  window.location.hash = '';
  showLogin();
  toast('Signed out.');
});

$('#menu-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

window.addEventListener('hashchange', renderRoute);

/**
 * If the database has no accounts, say so on the login screen. Otherwise the
 * demo buttons below promise logins that cannot possibly work.
 */
async function checkSetupState() {
  let health;
  try {
    health = await api.get('/health');
  } catch {
    return;
  }
  if (!health?.setupRequired) return;

  $('.demo-hint').innerHTML = `
    <strong>No accounts exist yet.</strong><br />
    Stop the server and run <code>npm run seed</code> to create the demo
    accounts, then start it again.`;

  const errorBox = $('#login-error');
  errorBox.textContent = 'This database is empty — there is nobody to sign in as yet.';
  errorBox.classList.remove('hidden');
}

/* ------------------------------------------------------------------ boot */

try {
  const { user } = await api.get('/auth/me');
  showApp(user);
} catch {
  showLogin();
  checkSetupState();
}
