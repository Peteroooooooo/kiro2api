/**
 * Resolve the CodeWhisperer profile ARN of a freshly logged-in account.
 *
 * Builder ID accounts all share one fixed placeholder ARN (the value kiro-cli
 * itself stores after a Builder ID login). IAM Identity Center accounts have a
 * real profile per organisation, listed by `ListAvailableProfiles` in the
 * regions Kiro runs in. The chat path works without a profile ARN; only
 * GetUsageLimits (quota display) requires it, so a lookup failure is not fatal.
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  getKiroClientProfile,
  renderShellUserAgent,
  renderShellXAmzUserAgent,
} from '../kiro/client-profile.js';
import { applyRetryHeaders } from '../kiro/retry-executor.js';
import { getLogger } from '../shared/logger.js';

export const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
export const BUILDER_ID_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';

const PROFILE_REGIONS: ReadonlyArray<{ region: string; host: string }> = [
  { region: 'us-east-1', host: 'codewhisperer.us-east-1.amazonaws.com' },
  { region: 'eu-central-1', host: 'q.eu-central-1.amazonaws.com' },
];

export interface ResolvedProfile {
  profileArn: string;
  /** Region the profile lives in; API calls must go to this region. */
  apiRegion: string;
}

export function isBuilderIdStartUrl(startUrl: string | undefined): boolean {
  return !startUrl || startUrl.replace(/\/+$/, '') === BUILDER_ID_START_URL;
}

export async function resolveProfile(
  accessToken: string,
  startUrl: string | undefined,
): Promise<ResolvedProfile | undefined> {
  if (isBuilderIdStartUrl(startUrl)) {
    return { profileArn: BUILDER_ID_PROFILE_ARN, apiRegion: 'us-east-1' };
  }
  for (const { region, host } of PROFILE_REGIONS) {
    try {
      const arn = await listFirstProfile(accessToken, host);
      if (arn) return { profileArn: arn, apiRegion: arnRegion(arn) ?? region };
    } catch (e) {
      getLogger().warn({
        msg: 'ListAvailableProfiles failed',
        region,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return undefined;
}

async function listFirstProfile(accessToken: string, host: string): Promise<string | undefined> {
  const profile = getKiroClientProfile();
  const headers: Record<string, string> = {
    ...profile.shell.staticHeaders,
    'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
    'user-agent': renderShellUserAgent(profile),
    'x-amz-user-agent': renderShellXAmzUserAgent(profile),
    host,
    Authorization: `Bearer ${accessToken}`,
  };
  applyRetryHeaders(headers, uuidv4(), 1, { maxAttempts: 1, kiroAttemptHeader: false });
  const response = await axios.post(
    `https://${host}/`,
    {},
    {
      headers,
      timeout: 30_000,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
  const profiles = (response.data as { profiles?: Array<{ arn?: string }> }).profiles ?? [];
  return profiles.find((p) => typeof p.arn === 'string')?.arn;
}

function arnRegion(arn: string): string | undefined {
  return arn.split(':')[3] || undefined;
}
