// ProdPass - Record Deployment: sends one deployment to ProdPass's GitHub Actions integration.
// No dependencies: inputs come from INPUT_* variables, outputs go to $GITHUB_OUTPUT.
const https = require('https');
const http = require('http');
const fs = require('fs');

const STATUSES = ['succeeded', 'failed', 'in_progress', 'rolled_back'];

// ${{ job.status }} values, so a step can report the job outcome directly
const JOB_STATUS = { success: 'succeeded', failure: 'failed', cancelled: 'failed' };

function getInput(name, env = process.env) {
  return (env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

function normalizeStatus(raw) {
  const s = (raw || 'succeeded').toLowerCase().replace(/[\s-]+/g, '_');
  const status = JOB_STATUS[s] || s;

  if (!STATUSES.includes(status)) {
    throw new Error(`status must be one of ${STATUSES.join(', ')} (or a job status: success, failure, cancelled), got "${raw}"`);
  }

  return status;
}

function checkIsoTime(value, name) {
  if (value && Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO 8601 time (e.g. 2026-11-05T09:30:00Z), got "${value}"`);
  }
}

// Repeat-safe but unique per attempt and result, as ProdPass asks
function defaultEventId(env, target, status) {
  const parts = [
    'gh', env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT || '1', env.GITHUB_JOB, target, status
  ];

  return parts.filter(Boolean).join(':').replace(/[^\w.:/@-]+/g, '-').slice(0, 200);
}

// Reads and validates every input; throws before any network call
function buildRequest(env = process.env) {
  const url = getInput('prodpass_url', env);
  const token = getInput('prodpass_token', env);

  if (!url) throw new Error('Missing input: prodpass_url');
  if (!token) throw new Error('Missing input: prodpass_token');

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error('prodpass_url is not a valid URL: copy it from ProdPass > Deployment tools > GitHub Actions');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('prodpass_url must start with https://');
  }

  const instance = getInput('instance', env);
  const system = getInput('system', env);
  const environment = getInput('environment', env);

  if (instance && (system || environment)) {
    throw new Error('Send either instance, or system + environment, not both');
  }

  if (!instance && !(system && environment)) {
    throw new Error('Missing target: set instance, or both system and environment');
  }

  const version = getInput('version', env);

  if (!version) throw new Error('Missing input: version');

  const status = normalizeStatus(getInput('status', env));
  const startedAt = getInput('started_at', env);
  let finishedAt = getInput('finished_at', env);

  checkIsoTime(startedAt, 'started_at');
  checkIsoTime(finishedAt, 'finished_at');

  if (!finishedAt && status !== 'in_progress') {
    finishedAt = new Date().toISOString();
  }

  const component = getInput('component', env);
  const target = [instance || `${system}@${environment}`, component].filter(Boolean).join('/');

  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';

  const body = {
    ...(instance ? { instance } : { system, environment }),
    ...(component && { component }),
    version,
    status,
    ...(getInput('release', env) && { release: getInput('release', env) }),
    ...(getInput('project', env) && { project: getInput('project', env) }),
    ref: getInput('ref', env) || (env.GITHUB_SHA || '').slice(0, 7) || undefined,
    url: getInput('url', env) || runUrl || undefined,
    ...(startedAt && { startedAt }),
    ...(finishedAt && { finishedAt }),
    eventId: getInput('event_id', env) || defaultEventId(env, target, status)
  };

  const timeout = Number(getInput('timeout_seconds', env) || 30);

  if (!(timeout > 0)) throw new Error('timeout_seconds must be a positive number');

  return {
    url: parsed,
    token,
    body: JSON.parse(JSON.stringify(body)), // drops undefined fields
    timeoutMs: timeout * 1000,
    failOnUnmatched: getInput('fail_on_unmatched', env).toLowerCase() !== 'false'
  };
}

function post(url, token, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttp = url.protocol === 'http:';
    const req = (isHttp ? http : https).request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttp ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'prodpass-update-action/1'
      }
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: data, json });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

// Network errors and 5xx are retried with the same eventId, so ProdPass ignores any duplicate
async function postWithRetry(url, token, payload, timeoutMs, { attempts = 3, delayMs = 2000, log = console.log } = {}) {
  let lastError;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await post(url, token, payload, timeoutMs);

      if (res.status < 500) return res;

      lastError = new Error(`ProdPass answered HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    } catch (e) {
      lastError = new Error(`Could not reach ProdPass (${url.host}): ${e.message}`);
    }

    if (i < attempts) {
      log(`⚠️ ${lastError.message} (attempt ${i} of ${attempts}, retrying)`);
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }

  throw lastError;
}

// Output values must stay on one line, or a stray newline could inject extra outputs
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ');

function writeOutputs(env, values) {
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${oneLine(v)}\n`).join(''));
  }
}

function writeSummary(env, body, outcome, summary) {
  if (!env.GITHUB_STEP_SUMMARY) return;

  const target = body.instance || `${body.system} in ${body.environment}`;
  const icon = outcome === 'applied' ? '✅' : '⚠️';

  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, [
    '### ProdPass deployment',
    '',
    '| Target | Component | Version | Status | Outcome |',
    '|---|---|---|---|---|',
    `| ${target} | ${body.component || '-'} | ${body.version} | ${body.status} | ${icon} ${outcome}: ${oneLine(summary)} |`,
    ''
  ].join('\n') + '\n');
}

async function run(env = process.env, opts = {}) {
  const { url, token, body, timeoutMs, failOnUnmatched } = buildRequest(env);
  const payload = JSON.stringify(body);

  if (url.protocol === 'http:') {
    console.warn('⚠️ prodpass_url uses http:// - the token is sent unencrypted');
  }

  console.log(`📡 POST ${url.origin}${url.pathname}`);
  console.log(`📦 ${payload}`);

  const res = await postWithRetry(url, token, payload, timeoutMs, opts);

  console.log(`📨 HTTP ${res.status}: ${res.body.slice(0, 1000)}`);

  if (res.status === 401 || res.status === 403) {
    throw new Error(`ProdPass rejected the token (HTTP ${res.status}): check the PRODPASS_TOKEN secret and that the connection is turned on. ${res.body.slice(0, 300)}`);
  }

  if (res.status >= 400) {
    throw new Error(`ProdPass rejected the deployment (HTTP ${res.status}): ${res.body.slice(0, 500)}`);
  }

  if (!res.json || res.json.ok !== true) {
    throw new Error(`Unexpected reply from ProdPass (HTTP ${res.status}): ${res.body.slice(0, 500)}`);
  }

  const outcome = res.json.outcome || '';
  const summary = res.json.summary || '';

  writeOutputs(env, { outcome, summary, event_id: body.eventId, response: JSON.stringify(res.json) });
  writeSummary(env, body, outcome, summary);

  if (outcome === 'unmatched') {
    const msg = `ProdPass did not record the deployment: ${summary}`;

    if (failOnUnmatched) throw new Error(msg);

    console.warn(`⚠️ ${msg} (fail_on_unmatched is false, so the step continues)`);
    return res.json;
  }

  console.log(`✅ ${summary || 'Deployment recorded in ProdPass'}`);
  return res.json;
}

module.exports = { run, buildRequest, normalizeStatus, defaultEventId };

if (require.main === module) {
  run().catch((err) => {
    console.log(`::error::${oneLine(err.message)}`);
    process.exit(1);
  });
}
