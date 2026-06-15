// End-to-end API smoke test against a running server.
const BASE = 'http://localhost:3000';
let token = null;
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failures++;
    console.error(`  FAIL: ${name} ${extra}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// --- auth ---
console.log('auth:');
let r = await req('POST', '/api/login', { pin: '9999' });
check('wrong PIN rejected', r.status === 401);
r = await req('GET', '/api/employees');
check('no token rejected', r.status === 401);
r = await req('POST', '/api/login', { pin: '1234' });
check('correct PIN accepted', r.status === 200 && r.data.token);
token = r.data.token;
check('login reports vision_ready=false (no key)', r.data.vision_ready === false);

// --- employees ---
console.log('employees:');
r = await req('GET', '/api/employees');
check('3 seeded employees', r.data.length === 3, JSON.stringify(r.data));
const [e1, e2] = r.data;
r = await req('PATCH', `/api/employees/${e1.id}`, { name: 'Анна' });
check('rename works', r.data.name === 'Анна');
r = await req('POST', '/api/employees', { name: 'Ольга' });
const e4 = r.data;
check('add employee', e4.name === 'Ольга');
r = await req('POST', `/api/employees/${e4.id}/archive`, {});
check('archive employee', r.data.ok === true);
r = await req('GET', '/api/employees');
check('archived stays in list as archived', r.data.find((e) => e.id === e4.id)?.status === 'archived');

// --- weeks ---
console.log('weeks:');
r = await req('POST', '/api/weeks', {});
const week = r.data;
check('create week with auto label', /^Неделя \d+$/.test(week.label), week.label);

// --- invoices & calculation ---
console.log('invoices/calculation:');
const mk = (emp, number, amount, paid) =>
  req('POST', '/api/invoices', { week_id: week.id, employee_id: emp, number, amount, paid });
await mk(e1.id, 1627, 300, true);
await mk(e1.id, 1630, 220, true);
await mk(e1.id, 1640, 150, false); // unpaid — excluded from sum
await mk(e2.id, 1628, 500, true);
await mk(e2.id, 1627, 999, true); // duplicate number across employees

r = await req('GET', `/api/weeks/${week.id}/employee/${e1.id}`);
check('sum excludes unpaid (300+220)', r.data.sum === 520, `sum=${r.data.sum}`);
check('half = round(520/2)', r.data.half === 260);
check('standing adjustments auto-created', r.data.adjustments.length === 2);
const patent = r.data.adjustments.find((a) => a.label === 'Патент');
const avans = r.data.adjustments.find((a) => a.label === 'Аванс');
check('Патент & Аванс present, deductions, 0 by default',
  patent && avans && patent.sign === '-' && patent.amount === 0);

await req('PATCH', `/api/adjustments/${patent.id}`, { amount: 100 });
await req('PATCH', `/api/adjustments/${avans.id}`, { amount: 50 });
r = await req('POST', '/api/adjustments', {
  week_id: week.id, employee_id: e1.id, label: 'Платье', sign: '-', amount: 40
});
const custom = r.data;
check('custom adjustment has date', Boolean(custom.date));
await req('POST', '/api/adjustments', {
  week_id: week.id, employee_id: e1.id, label: 'Сдельная', sign: '+', amount: 30
});

r = await req('GET', `/api/weeks/${week.id}/employee/${e1.id}`);
check('payout = 260 - 100 - 50 - 40 + 30 = 100', r.data.payout === 100, `payout=${r.data.payout}`);

r = await req('DELETE', `/api/adjustments/${patent.id}`);
check('standing adjustment cannot be deleted', r.status === 400);

// edit invoice
r = await req('GET', `/api/weeks/${week.id}/employee/${e1.id}`);
const inv = r.data.invoices[0];
r = await req('PATCH', `/api/invoices/${inv.id}`, { amount: 350, needs_review: false });
check('invoice amount editable', r.data.amount === 350);
await req('PATCH', `/api/invoices/${inv.id}`, { amount: 300 });

// --- checks ---
console.log('weekly checks:');
r = await req('GET', `/api/weeks/${week.id}/checks`);
check('duplicate 1627 flagged across employees',
  r.data.duplicates.length === 1 && r.data.duplicates[0].number === 1627 && r.data.duplicates[0].entries.length === 2);
check('missing numbers 1629,1631..1639 found',
  r.data.missing.includes(1629) && r.data.missing.includes(1639) && !r.data.missing.includes(1628));
check('unpaid invoice listed', r.data.unpaid.length === 1 && r.data.unpaid[0].number === 1640);

// --- overview ---
console.log('overview:');
r = await req('GET', `/api/weeks/${week.id}/overview`);
const ov1 = r.data.employees.find((e) => e.id === e1.id);
check('overview payout matches', ov1.payout === 100, `payout=${ov1.payout}`);
check('overview counts unpaid', ov1.unpaid_count === 1);
check('archived employee not in overview', !r.data.employees.some((e) => e.id === e4.id));

// --- scan without API key (graceful degradation) ---
console.log('scan (no API key):');
const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
r = await req('POST', '/api/scan', { week_id: week.id, employee_id: e2.id, image: tinyPng });
check('scan returns ok=false with Russian error', r.data.ok === false && /не настроен/i.test(r.data.error), r.data.error);
check('scan creates manual-entry row with photo', r.data.invoices?.length === 1 && r.data.invoices[0].photo_ref);
check('manual row flagged needs_review', r.data.invoices[0].needs_review === 1);

// photo retrievable
const photoRes = await fetch(`${BASE}/api/photos/${r.data.invoices[0].photo_ref}?t=${token}`);
check('photo served with query token', photoRes.status === 200);
const photoNoAuth = await fetch(`${BASE}/api/photos/${r.data.invoices[0].photo_ref}`);
check('photo rejected without token', photoNoAuth.status === 401);

// --- static frontend ---
console.log('static:');
const home = await fetch(BASE + '/');
const html = await home.text();
check('index.html served', home.status === 200 && html.includes('Зарплата'));
const manifest = await fetch(BASE + '/manifest.webmanifest');
check('manifest served', manifest.status === 200);
const sw = await fetch(BASE + '/sw.js');
check('service worker served', sw.status === 200);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
