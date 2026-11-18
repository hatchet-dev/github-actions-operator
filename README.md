# github-actions-operator

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hatchet-dev/github-actions-operator)

Run your GitHub Actions jobs in [Hatchet](https://hatchet.run) sandboxes. Put `runs-on: hatchet` in a workflow and every job gets a fresh sandbox, a just-in-time GitHub runner, and nothing to host. The control logic is a durable task on a Hatchet serverless endpoint deployed as a Cloudflare Worker.

## How it works

1. Your GitHub App sends a `workflow_job` webhook to a Hatchet incoming webhook.
2. Hatchet turns the `queued` event into a run of `github-actions-on-job` on your Worker. For a job with the `hatchet` label it starts the `github-actions-run-job` durable task, tagged with the repo, workflow, job and run URL.
3. The task mints a just-in-time runner config with an installation token of your App, creates a sandbox from the official `actions/actions-runner` image, starts `dockerd`, and starts `run.sh --jitconfig`.
4. The task sleeps until GitHub sends the matching `completed` event, checking every few minutes that the runner is still alive, then deletes the sandbox.

GitHub keeps the logs and the status checks. Hatchet keeps a run per job with the sandbox turns as children. Filter the runs list by the `github.repo` or `github.job` metadata to find a job, and follow `github.job_url` on the run to its GitHub page.

## Prerequisites

- A Hatchet Cloud tenant with `Serverless` and `Sandboxes` turned on under `Settings` > `Labs Preview`.
- A sandbox provider added under `Sandboxes`. Archil is the only provider that runs an arbitrary OCI image. Use this config and change the region as needed.

  ```json
  {"region":"aws-us-east-1","workdir":"/home/runner"}
  ```

  On Daytona, E2B or Freestyle build a snapshot from `ghcr.io/actions/actions-runner:2.338.2` and set `SANDBOX_TEMPLATE` to its name.
- Node 24, pnpm, and a Cloudflare account with `wrangler login` done.

## Setup

### 1. Hatchet webhook

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Put your Hatchet token in `.dev.vars` and run the setup once. It creates the Hatchet webhook and prints the webhook URL and secret for the next step.

```sh
pnpm register
```

### 2. GitHub App

Create a GitHub App under your account or organization at `Settings` > `Developer settings` > `GitHub Apps` > `New GitHub App`.

- Webhook. Active, with the URL and secret from step 1.
- Repository permissions. `Actions` read-only and `Administration` read and write. Nothing else.
- Subscribe to events. `Workflow jobs`. The checkbox appears once `Actions` is granted.
- Where can this GitHub App be installed. Only on this account, unless others should install it too.
- Leave `Request user authorization (OAuth) during installation` off. The App needs no callback URL.

Create it, note the App ID, generate a private key and download the `.pem`. Then install the App on the repositories that should run on Hatchet.

### 3. Deploy the Worker

Click the button above. Cloudflare copies this repository into your GitHub account, asks for the secrets listed in `.dev.vars.example`, and deploys the Worker. Generate `HATCHET_SIGNING_SECRET` with `openssl rand -hex 32`. Paste the private key as is, or with `\n` in place of line breaks.

Or deploy from the clone.

```sh
wrangler secret put HATCHET_CLIENT_TOKEN
wrangler secret put HATCHET_SIGNING_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY < app.private-key.pem
wrangler secret put SANDBOX_PROVIDER
pnpm deploy
```

### 4. Register the endpoint

Fill in `HATCHET_SIGNING_SECRET` in `.dev.vars` and run the setup again with the Worker URL. It adds the serverless endpoint and leaves the webhook alone.

```sh
pnpm register https://github-actions-operator.<you>.workers.dev
```

Then use the label in a workflow.

```yaml
jobs:
  test:
    runs-on: hatchet
    steps:
      - uses: actions/checkout@v4
      - run: uname -a
```

## Variables

Secrets are Worker secrets. The rest have defaults under `[vars]` in `wrangler.toml` and can be overridden there or as secrets.

| Variable | Meaning |
| --- | --- |
| `HATCHET_CLIENT_TOKEN` | Your Hatchet API token. |
| `HATCHET_SIGNING_SECRET` | 32+ characters. The endpoint's signing secret in Hatchet, set by `pnpm register`. |
| `GITHUB_APP_ID` | The App ID from the App's settings page. |
| `GITHUB_APP_PRIVATE_KEY` | The App's private key in PEM form. |
| `RUNNER_LABEL` | Jobs whose labels do not include it are skipped. Default `hatchet`. |
| `SANDBOX_TEMPLATE` | Image or provider snapshot for the sandbox. Default `ghcr.io/actions/actions-runner:2.338.2`. |
| `SANDBOX_PROVIDER` | Provider name. Required when the tenant has more than one. |
| `SANDBOX_VCPU`, `SANDBOX_MEMORY_MIB` | Sandbox size. Omit for the provider default. |
| `JOB_TIMEOUT` | The sandbox is deleted after this even if GitHub never reports the job done. Default `6h`. |
| `KEEPALIVE_INTERVAL` | How often the task checks that the runner is still alive. Keep it under the provider's max idle TTL, which defaults to 15 minutes. Default `5m`. |

## Notes

- The just-in-time config is passed to the sandbox as a command, so it is visible in the Hatchet dashboard as task input. It is single use, bound to one job, and useless once the runner has registered.
- `dockerd` is started inside the sandbox before the runner, so `docker build`, `container:` jobs and Docker actions work. Jobs that call `systemctl` fail, there is no init system.
- The runner runs as root inside the sandbox.
- Runners are registered per repository on every repository the App is installed on. Installation tokens stay in the Worker.

## When GitHub is down

The runner config request is a Hatchet task of its own with three retries and backoff on network errors and 5xx responses. Every `KEEPALIVE_INTERVAL` the task checks whether the runner process has exited and ends the run with `runner-exited-<code>` if it has, so a runner that never reached GitHub costs one interval of sandbox time, not `JOB_TIMEOUT`. The sandbox is deleted on every path. A job left queued in GitHub is not retried from here. Re-run it in GitHub, or redeliver the webhook, and GitHub fails it on its own after 24 hours.

## Local development

`wrangler dev` serves the Worker on localhost. Hatchet only calls public HTTPS endpoints, so put a tunnel such as `cloudflared tunnel --url http://localhost:8787` in front and register that URL with `pnpm register`.
