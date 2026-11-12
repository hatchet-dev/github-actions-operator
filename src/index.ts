import { cloudflare } from '@hatchet-dev/serverless/cloudflare';
import { workflows } from './tasks';

export default cloudflare({ workflows });
