# ProdPass - Record Deployment

A GitHub Action that records a deployment in **ProdPass**: which version went to which instance (or component), whether it succeeded, and which run did it. A successful deployment updates the instance's deployed version, places the deployment in a deployment window, and links it to a release.

It talks to ProdPass's **Deployment tools › GitHub Actions** connection, and does what ProdPass's copy-paste `curl` step does, with the gaps closed:

- **Builds the JSON safely**: no hand-written heredoc, so quotes or newlines in a version or ref can't break the request.
- **Fails when nothing was recorded**: ProdPass answers HTTP 200 with `"outcome": "unmatched"` when no instance matches, which `curl -f` treats as success. This action fails the step instead (or warns, if you prefer).
- **Safe to retry and re-run**: every attempt gets a unique `eventId`; network errors and 5xx answers are retried with the same ID, so ProdPass never records a deployment twice.
- **Reports the job's real outcome**: pass `${{ job.status }}` and it maps to `succeeded` or `failed`.
- **Times out** instead of hanging the job, and explains token, validation and connection errors in plain words.
- No dependencies; nothing is downloaded at run time.

## Setup

1. In ProdPass, go to **Integrations › Deployment tools**, add **GitHub Actions**, and copy the **URL** and **token** (the token is shown once).
2. In your GitHub repository, **Settings › Secrets and variables › Actions**:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `PRODPASS_TOKEN` | the `ermi_…` token |
   | Variable | `PRODPASS_URL` | `https://<your-prodpass>/hooks/integrations/<id>` |

   The URL isn't secret; keeping it a variable leaves it readable in logs. If you use GitHub Environments, add them there instead and set `environment:` on the job.

3. Add a step at the **end of your deploy job** (below).

## Usage

### Record the deployment, whatever the outcome

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: uat
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh uat2          # your deployment

      - name: Report deployment to ProdPass
        if: always()                   # also report failures
        uses: hpashok24/prodpass-update-action@v1
        with:
          prodpass_url: ${{ vars.PRODPASS_URL }}
          prodpass_token: ${{ secrets.PRODPASS_TOKEN }}
          instance: payment-hub.uat2
          version: ${{ github.ref_name }}
          status: ${{ job.status }}
```

### A microservice: system + environment + component

When the pipeline knows the system and environment but not the instance code:

```yaml
      - uses: hpashok24/prodpass-update-action@v1
        if: always()
        with:
          prodpass_url: ${{ vars.PRODPASS_URL }}
          prodpass_token: ${{ secrets.PRODPASS_TOKEN }}
          system: payment-hub
          environment: UAT2
          component: payments-api        # a new code adds the component (unless turned off in ProdPass)
          version: ${{ needs.build.outputs.version }}
          status: ${{ job.status }}
```

### Mark it in progress, then finished

```yaml
      - uses: hpashok24/prodpass-update-action@v1
        id: started
        with:
          prodpass_url: ${{ vars.PRODPASS_URL }}
          prodpass_token: ${{ secrets.PRODPASS_TOKEN }}
          instance: payment-hub.prod
          version: ${{ github.ref_name }}
          status: in_progress
          started_at: ${{ github.event.head_commit.timestamp }}

      - run: ./deploy.sh prod

      - uses: hpashok24/prodpass-update-action@v1
        if: always()
        with:
          prodpass_url: ${{ vars.PRODPASS_URL }}
          prodpass_token: ${{ secrets.PRODPASS_TOKEN }}
          instance: payment-hub.prod
          version: ${{ github.ref_name }}
          status: ${{ job.status }}
          release: REL-00012
```

### Use the result in later steps

```yaml
      - uses: hpashok24/prodpass-update-action@v1
        id: prodpass
        with: { ... }
      - run: echo "ProdPass said: ${{ steps.prodpass.outputs.summary }}"
```

## Inputs

| Input | Required | Description |
|---|---|---|
| `prodpass_url` | ✅ | The URL from ProdPass's GitHub Actions connection. |
| `prodpass_token` | ✅ | The connection's token, from a secret. |
| `instance` | one target | Instance code (`payment-hub.uat2`), or its **Pipeline reference** when only one instance has it. |
| `system` + `environment` | one target | System and environment codes, instead of `instance`. |
| `component` | | Component code for a system deployed in parts. A new code adds the component unless that's turned off in ProdPass. |
| `version` | ✅ | The version deployed. |
| `status` | | `succeeded` (default), `failed`, `in_progress`, `rolled_back`, or a job status: `success`, `failure`, `cancelled`. |
| `release` | | Release code (`REL-00012`). Left out, ProdPass matches by system and version; `none` skips matching. |
| `project` | | Project code. Left out, the release's project. |
| `ref` | | Build or change reference. Default: the commit's short SHA. |
| `url` | | Link to the run. Default: this workflow run. |
| `started_at`, `finished_at` | | ISO 8601 times, used to place the deployment in a window. `finished_at` defaults to now (not for `in_progress`). |
| `event_id` | | Repeat-safe ID. Default: unique per repository, run, attempt, job, target and status. |
| `fail_on_unmatched` | | `true` (default): fail the step when ProdPass matches no instance. `false`: warn and continue. |
| `timeout_seconds` | | Per-request timeout, default `30`. |

## Outputs

| Output | Description |
|---|---|
| `outcome` | ProdPass's outcome: `applied` or `unmatched`. |
| `summary` | ProdPass's one-line summary, e.g. `payment-hub.uat2 1.4.2 recorded as succeeded`. |
| `event_id` | The event ID sent, to find the call in ProdPass's **Recent calls**. |
| `response` | The raw JSON reply. |

A short table is also added to the job's summary page.

## Behaviour

- **Re-runs**: a re-run is a new attempt, so it gets a new `eventId` and is recorded again. Sending the same `event_id` twice is answered `(already recorded)` and changes nothing.
- **Retries**: network errors, timeouts and 5xx answers are retried twice (after 2 s and 4 s) with the same `eventId`. 4xx answers are not retried.
- **Matching**: `instance` matches an instance code first, then a Pipeline reference. For GitHub Deployments set the Pipeline reference to `owner/repo:environment`.

## Troubleshooting

| Message | Fix |
|---|---|
| `ProdPass rejected the token (HTTP 401)` | Check the `PRODPASS_TOKEN` secret, that the connection is **turned on**, and that its token wasn't replaced with **New token**. |
| `ProdPass did not record the deployment: no instance matches "…"` | The instance code or Pipeline reference doesn't exist. Codes are case-sensitive. |
| `ProdPass rejected the deployment (HTTP 400): …` | A field is invalid; the message names it. |
| `Could not reach ProdPass … no answer within 30s` | The runner can't reach ProdPass: for a private instance use a self-hosted runner. |
| `Missing target: set instance, or both system and environment` | Give exactly one target. |

## Development

```bash
npm test
```

Runs the unit tests against a local mock of ProdPass (no network). `.github/workflows/test.yml` runs them on every push, and has a manual end-to-end run against a real ProdPass.

### Releasing

Publish a full version tag **and** move the major tag, so `@v1` keeps working:

```bash
git tag -a v1.0.0 -m "v1.0.0" && git tag -f v1 && git push origin v1.0.0 && git push -f origin v1
```

## Security

- The token only allows recording deployments on this ProdPass connection. Keep it in a secret; it is never printed.
- The action needs no GitHub token permissions: set `permissions: {}` (or `contents: read` if you check out code).
- Don't run it from `pull_request_target` workflows: they expose secrets to code from forks.

## License

MIT
