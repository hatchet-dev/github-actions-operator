import { randomBytes } from 'node:crypto';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import {
  V1ServerlessEndpointKind,
  V1WebhookHMACAlgorithm,
  V1WebhookHMACEncoding,
  V1WebhookSourceName,
} from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts';

const WEBHOOK = 'github-actions';
const ENDPOINT = 'github-actions-operator';

const url = process.argv[2]?.replace(/\/$/, '');
if (url && !process.env.HATCHET_SIGNING_SECRET) {
  console.error('HATCHET_SIGNING_SECRET must be set to register the endpoint');
  process.exit(1);
}

const hatchet = HatchetClient.init();
const tenant = hatchet.tenantId;

const webhooks = await hatchet.webhooks.list({ webhookNames: [WEBHOOK] });
let secret = '(unchanged, set when the webhook was created)';
if (!webhooks.rows?.length) {
  secret = randomBytes(32).toString('hex');
  await hatchet.webhooks.create({
    name: WEBHOOK,
    sourceName: V1WebhookSourceName.GITHUB,
    eventKeyExpression: "'github:' + headers['x-github-event'] + ':' + input.action",
    auth: {
      algorithm: V1WebhookHMACAlgorithm.SHA256,
      encoding: V1WebhookHMACEncoding.HEX,
      signatureHeaderName: 'X-Hub-Signature-256',
      signingSecret: secret,
    },
  });
}

if (url) {
  const endpoints = await hatchet.api.v1ServerlessEndpointList(tenant, {});
  if (!endpoints.data.rows?.some((e) => e.name === ENDPOINT)) {
    await hatchet.api.v1ServerlessEndpointCreate(tenant, {
      name: ENDPOINT,
      kind: V1ServerlessEndpointKind.CLOUDFLARE_WORKERS,
      healthcheckUrl: `${url}/hatchet/healthcheck`,
      triggerUrl: `${url}/hatchet/trigger`,
      signingSecret: process.env.HATCHET_SIGNING_SECRET!,
    });
  }
  console.log(`Serverless endpoint ${ENDPOINT} registered for ${url}`);
}

console.log(`
Webhook settings for your GitHub App:

  Webhook URL     ${hatchet.config.api_url}/api/v1/stable/tenants/${tenant}/webhooks/${WEBHOOK}
  Webhook secret  ${secret}
`);
