/**
 * Tiny fake backend for the example app, mounted into Metro's dev server
 * (see metro.config.js). Only fake data; nothing leaves the machine.
 */
const BOOKING = {
  id: 'BK-1042',
  status: 'Confirmed',
  route: { from: 'YUL', to: 'CDG' },
  departure: '2026-11-14T18:35:00-05:00',
  passengers: [{ name: 'Alex Tester', seat: '23A' }, { name: 'Sam Example', seat: '23B' }],
  baggage: '2 × 23 kg checked, 1 carry-on each',
  fareRules: 'Changes allowed with fee. Non-refundable after 24 h.',
  total: { amount: 1284.5, currency: 'CAD' },
};

const ITINERARY = [
  { flight: 'XA 870', from: 'YUL', to: 'CDG', depart: '18:35', arrive: '07:50 +1', aircraft: 'A330-300' },
  { flight: 'XA 871', from: 'CDG', to: 'YUL', depart: '10:40', arrive: '12:35', aircraft: 'A330-300' },
];

function send(res, status, body, delayMs = 0) {
  setTimeout(() => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }, delayMs);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = async function mockApi(req, res) {
  const url = req.url.replace(/^\/example-api/, '').split('?')[0];
  if (req.method === 'POST' && url === '/login') {
    const body = await readJson(req);
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email || '') && body.password === 'password123';
    return ok
      ? send(res, 200, { token: 'fake-session-token-7f3a9c', user: { name: 'Alex Tester' } }, 700)
      : send(res, 401, { error: 'Invalid email or password' }, 700);
  }
  if (req.method === 'GET' && url === '/bookings/BK-1042') return send(res, 200, BOOKING, 400);
  if (req.method === 'GET' && url === '/bookings/BK-1042/itinerary') return send(res, 200, ITINERARY, 300);
  if (url === '/flaky') return send(res, 500, { error: 'Internal server error (simulated)' }, 250);
  if (url === '/slow') return send(res, 200, { message: 'Finally done' }, 3000);
  return send(res, 404, { error: `No mock for ${req.method} ${url}` });
};
