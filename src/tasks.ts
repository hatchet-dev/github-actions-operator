import { env } from 'cloudflare:workers';
import { hatchet, NonRetryableError, type JsonObject } from '@hatchet-dev/serverless';
import { commandOutput, turnResult, type TurnInput } from '@hatchet-dev/sandbox/wire';
import { Or, durationToMs, type Duration } from '@hatchet-dev/typescript-sdk/edge';
import { z } from 'zod';

declare global {
  namespace Cloudflare {
    interface Env {
      GITHUB_APP_ID?: string;
      GITHUB_APP_PRIVATE_KEY?: string;
      RUNNER_LABEL?: string;
      SANDBOX_TEMPLATE?: string;
      SANDBOX_PROVIDER?: string;
      SANDBOX_VCPU?: string;
      SANDBOX_MEMORY_MIB?: string;
      JOB_TIMEOUT?: string;
      KEEPALIVE_INTERVAL?: string;
    }
  }
}

const SANDBOX = 'hatchet-sandbox';
const COMPLETED = 'github:workflow_job:completed';
const GITHUB_DEFAULT_LABELS = ['self-hosted', 'linux', 'x64', 'X64'];

const jobEvent = z.object({
  workflow_job: z.object({
    id: z.number(),
    name: z.string(),
    labels: z.array(z.string()),
    html_url: z.string(),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
});

type JobEvent = z.infer<typeof jobEvent>;

const int = (v?: string) => (v ? Number.parseInt(v, 10) : undefined);

function b64url(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(n: number) {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function pemToPkcs8(pem: string) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  if (!pem.includes('RSA PRIVATE KEY')) return der;
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...rsaEncryption, 0x04, ...derLength(der.length), ...der];
  return Uint8Array.from([0x30, ...derLength(inner.length), ...inner]);
}

async function appJwt() {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new NonRetryableError('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

async function github<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-actions-operator',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return (await res.json()) as T;
  const message = `${path} ${res.status}: ${await res.text()}`;
  if (res.status !== 429 && res.status < 500) throw new NonRetryableError(message);
  throw new Error(message);
}

const installationTokens = new Map<number, { token: string; expiresAt: number }>();

async function installationToken(id: number) {
  const cached = installationTokens.get(id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const { token, expires_at } = await github<{ token: string; expires_at: string }>(`/app/installations/${id}/access_tokens`, await appJwt(), {});
  installationTokens.set(id, { token, expiresAt: Date.parse(expires_at) });
  return token;
}

export const mintJit = hatchet.task({
  name: 'github-actions-mint-jit',
  retries: 3,
  backoff: { factor: 2, maxSeconds: 30 },
  hatchetClient: false,
  fn: async (input: { installationId: number; repo: string; jobId: number; labels: string[] }) => {
    const token = await installationToken(input.installationId);
    const { encoded_jit_config } = await github<{ encoded_jit_config: string }>(`/repos/${input.repo}/actions/runners/generate-jitconfig`, token, {
      name: `hatchet-${input.jobId}`,
      runner_group_id: 1,
      labels: input.labels.filter((l) => !GITHUB_DEFAULT_LABELS.includes(l)),
      work_folder: '_work',
    });
    return { jitConfig: encoded_jit_config };
  },
});

export const runJob = hatchet.durableTask({
  name: 'github-actions-run-job',
  onEvents: ['github:workflow_job:queued'],
  executionTimeout: '7h',
  fn: async (input: JobEvent, ctx) => {
    const { workflow_job: job, repository, installation } = jobEvent.parse(input);
    const label = env.RUNNER_LABEL ?? 'hatchet';
    if (!job.labels.includes(label)) {
      return { skipped: `labels [${job.labels.join(', ')}] do not include ${label}` };
    }

    const timeoutMs = durationToMs((env.JOB_TIMEOUT ?? '6h') as Duration);
    const intervalMs = durationToMs((env.KEEPALIVE_INTERVAL ?? '5m') as Duration);
    const since = await ctx.now();
    const deadline = since.getTime() + timeoutMs;
    const { jitConfig } = await ctx.spawnChild(mintJit, {
      installationId: installation.id,
      repo: repository.full_name,
      jobId: job.id,
      labels: job.labels,
    });
    const sandboxId = `gha-${job.id}`;
    const turn = async (t: Omit<TurnInput, 'sandboxId'>) => {
      const r = await ctx.spawnChild<JsonObject, JsonObject>(SANDBOX, { ...t, sandboxId } as JsonObject);
      return turnResult.parse(r[SANDBOX] ?? r);
    };
    const command = async (cmd: string, timeoutMs: number) =>
      commandOutput.parse((await turn({ fn: '$command', input: { cmd, timeoutMs } })).output);

    const vcpu = int(env.SANDBOX_VCPU);
    const memoryMib = int(env.SANDBOX_MEMORY_MIB);
    await turn({
      fn: '$create',
      input: {},
      image: env.SANDBOX_TEMPLATE ?? 'ghcr.io/actions/actions-runner:2.338.2',
      idleTtlMs: intervalMs * 3,
      metadata: {
        ...(env.SANDBOX_PROVIDER ? { provider: env.SANDBOX_PROVIDER } : {}),
        'gha.repo': repository.full_name,
        'gha.job': String(job.id),
      },
      ...(vcpu || memoryMib ? { resources: { vcpu, memoryMib } } : {}),
    });

    try {
      await command(
        `command -v dockerd >/dev/null || exit 0; sudo -n setsid sh -c 'dockerd --data-root /home/runner/.docker >/tmp/dockerd.log 2>&1' & sleep 60`,
        1000
      );
      const docker = await command(
        `command -v dockerd >/dev/null || exit 0; for i in $(seq 90); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; tail -50 /tmp/dockerd.log; exit 1`,
        120_000
      );
      if (docker.exitCode !== 0) throw new Error(`dockerd did not start\n${docker.stdout}`);

      await command(
        `cd /home/runner && RUNNER_ALLOW_RUNASROOT=1 setsid sh -c './run.sh --jitconfig ${jitConfig} >/tmp/runner.log 2>&1; echo $? >/tmp/rc' & sleep 60`,
        1000
      );

      let conclusion = 'timeout';
      let rc = '';
      for (let i = 0; ; i++) {
        const remaining = deadline - (await ctx.now()).getTime();
        if (remaining <= 0) break;
        const done = await ctx.waitFor(
          Or(
            {
              eventKey: COMPLETED,
              expression: `input.workflow_job.id == ${job.id}`,
              considerEventsSince: since.toISOString(),
              readableDataKey: `completed-${i}`,
            },
            { sleepFor: Math.min(remaining, rc ? 30_000 : intervalMs), readableDataKey: `sleep-${i}` }
          )
        );
        const raw = done.CREATE?.[`completed-${i}`]?.[0];
        if (raw) {
          const event = (raw.data ?? raw) as { workflow_job?: { conclusion?: string } };
          conclusion = event.workflow_job?.conclusion ?? 'completed';
          break;
        }
        if (rc) {
          conclusion = `runner-exited-${rc}`;
          break;
        }
        rc = (await command('cat /tmp/rc 2>/dev/null', 10_000)).stdout.trim();
      }

      const log = await command('tail -c 4000 /tmp/runner.log', 10_000);
      return { job: job.html_url, conclusion, sandboxId, runnerLog: log.stdout };
    } finally {
      await turn({ fn: '$delete', input: {} });
    }
  },
});

export const workflows = [runJob, mintJit];
