// Unit tests: node --test (no dependencies). A local HTTP server stands in for ProdPass.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, buildRequest, normalizeStatus } = require('../dist/index.js');

const GH = {
  GITHUB_REPOSITORY: 'acme/payments', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'deploy',
  GITHUB_SHA: 'abcdef1234567890', GITHUB_SERVER_URL: 'https://github.com'
};

function env(inputs, extra = {}) {
  const e = { ...GH, ...extra };
  for (const [k, v] of Object.entries(inputs)) e[`INPUT_${k.toUpperCase()}`] = v;
  return e;
}

// Answers each request with the next reply; records what was received
function mockProdPass(replies) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      const r = replies[Math.min(received.length - 1, replies.length - 1)];
      if (r.hang) return; // never answers: exercises the timeout
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}/hooks/integrations/test`, received, close: () => server.close() })));
}

const quiet = { log: () => {}, delayMs: 10 };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')), 'out');

test('builds an instance deployment with GitHub defaults', () => {
  const { body } = buildRequest(env({ prodpass_url: 'https://x/hooks/integrations/1', prodpass_token: 't', instance: 'payment-hub.uat2', version: '1.4.2' }));
  assert.equal(body.instance, 'payment-hub.uat2');
  assert.equal(body.status, 'succeeded');
  assert.equal(body.ref, 'abcdef1');
  assert.equal(body.url, 'https://github.com/acme/payments/actions/runs/42');
  assert.equal(body.eventId, 'gh:acme/payments:42:1:deploy:payment-hub.uat2:succeeded');
  assert.ok(!Number.isNaN(Date.parse(body.finishedAt)));
  assert.equal(body.system, undefined);
});

test('builds a system + environment deployment with a component', () => {
  const { body } = buildRequest(env({ prodpass_url: 'https://x/h', prodpass_token: 't', system: 'payment-hub', environment: 'UAT2', component: 'payments-api', version: '2.0.0' }));
  assert.deepEqual([body.system, body.environment, body.component, body.instance], ['payment-hub', 'UAT2', 'payments-api', undefined]);
  assert.match(body.eventId, /payment-hub@UAT2\/payments-api:succeeded$/);
});

test('rejects a missing or ambiguous target, a missing version and bad times', () => {
  const base = { prodpass_url: 'https://x/h', prodpass_token: 't', version: '1' };
  assert.throws(() => buildRequest(env({ ...base })), /Missing target/);
  assert.throws(() => buildRequest(env({ ...base, system: 's' })), /Missing target/);
  assert.throws(() => buildRequest(env({ ...base, instance: 'i', system: 's', environment: 'e' })), /not both/);
  assert.throws(() => buildRequest(env({ prodpass_url: 'https://x/h', prodpass_token: 't', instance: 'i' })), /version/);
  assert.throws(() => buildRequest(env({ ...base, instance: 'i', started_at: 'yesterday' })), /ISO 8601/);
  assert.throws(() => buildRequest(env({ ...base, instance: 'i', prodpass_url: 'ftp://x' })), /https/);
  assert.throws(() => buildRequest(env({ ...base, instance: 'i', prodpass_token: '' })), /prodpass_token/);
});

test('maps job statuses and rejects unknown ones', () => {
  assert.equal(normalizeStatus('success'), 'succeeded');
  assert.equal(normalizeStatus('failure'), 'failed');
  assert.equal(normalizeStatus('cancelled'), 'failed');
  assert.equal(normalizeStatus('Rolled-Back'), 'rolled_back');
  assert.equal(normalizeStatus(''), 'succeeded');
  assert.throws(() => normalizeStatus('done'), /status must be one of/);
});

test('in_progress gets no finishedAt by default', () => {
  const { body } = buildRequest(env({ prodpass_url: 'https://x/h', prodpass_token: 't', instance: 'i', version: '1', status: 'in_progress' }));
  assert.equal(body.finishedAt, undefined);
});

test('applied: sends a Bearer token and writes outputs', async () => {
  const pp = await mockProdPass([{ status: 200, body: { ok: true, outcome: 'applied', summary: 'payment-hub.uat2 deployed 1.4.2' } }]);
  const out = tmpFile();
  try {
    await run(env({ prodpass_url: pp.url, prodpass_token: 'secret-token', instance: 'payment-hub.uat2', version: '1.4.2' }, { GITHUB_OUTPUT: out }), quiet);
    assert.equal(pp.received[0].headers.authorization, 'Bearer secret-token');
    assert.equal(pp.received[0].body.version, '1.4.2');
    const outputs = fs.readFileSync(out, 'utf8');
    assert.match(outputs, /^outcome=applied$/m);
    assert.match(outputs, /^summary=payment-hub.uat2 deployed 1.4.2$/m);
    assert.match(outputs, /^event_id=gh:/m);
  } finally { pp.close(); }
});

test('unmatched fails by default, and only warns when fail_on_unmatched is false', async () => {
  const pp = await mockProdPass([{ status: 200, body: { ok: true, outcome: 'unmatched', summary: 'no instance matches "x"' } }]);
  try {
    const inputs = { prodpass_url: pp.url, prodpass_token: 't', instance: 'x', version: '1' };
    await assert.rejects(run(env(inputs), quiet), /did not record the deployment/);
    const result = await run(env({ ...inputs, fail_on_unmatched: 'false' }), quiet);
    assert.equal(result.outcome, 'unmatched');
  } finally { pp.close(); }
});

test('401 and 400 are clear errors and are not retried', async () => {
  const pp = await mockProdPass([{ status: 401, body: { error: 'Wrong token' } }]);
  try {
    await assert.rejects(run(env({ prodpass_url: pp.url, prodpass_token: 'bad', instance: 'i', version: '1' }), quiet), /rejected the token/);
    assert.equal(pp.received.length, 1);
  } finally { pp.close(); }

  const pp2 = await mockProdPass([{ status: 400, body: { error: 'version: Required' } }]);
  try {
    await assert.rejects(run(env({ prodpass_url: pp2.url, prodpass_token: 't', instance: 'i', version: '1' }), quiet), /rejected the deployment \(HTTP 400\)/);
    assert.equal(pp2.received.length, 1);
  } finally { pp2.close(); }
});

test('5xx is retried with the same eventId', async () => {
  const pp = await mockProdPass([
    { status: 502, body: { error: 'bad gateway' } },
    { status: 200, body: { ok: true, outcome: 'applied', summary: 'ok' } }
  ]);
  try {
    await run(env({ prodpass_url: pp.url, prodpass_token: 't', instance: 'i', version: '1' }), quiet);
    assert.equal(pp.received.length, 2);
    assert.equal(pp.received[0].body.eventId, pp.received[1].body.eventId);
  } finally { pp.close(); }
});

test('a hung connection times out and fails after the retries', async () => {
  const pp = await mockProdPass([{ hang: true }]);
  try {
    await assert.rejects(
      run(env({ prodpass_url: pp.url, prodpass_token: 't', instance: 'i', version: '1', timeout_seconds: '0.2' }), quiet),
      /no answer within 0.2s/);
    assert.equal(pp.received.length, 3);
  } finally { pp.close(); }
});

// GitHub evaluates ${{ }} anywhere in action.yml, descriptions included, and refuses to load the action
test('action.yml contains no expressions', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  assert.doesNotMatch(yml, /\$\{\{/);
});

test('a non-JSON 200 (e.g. a proxy page) is an error, not a success', async () => {
  const pp = await mockProdPass([{ status: 200, body: '<html>login</html>' }]);
  try {
    await assert.rejects(run(env({ prodpass_url: pp.url, prodpass_token: 't', instance: 'i', version: '1' }), quiet), /Unexpected reply/);
  } finally { pp.close(); }
});
