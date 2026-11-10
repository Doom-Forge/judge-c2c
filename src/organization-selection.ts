import type { Env } from './env';

export const organizationNames = {
  doomForge: 'Doom-Forge',
  vitc: '180DC-VIT-CHENNAI',
} as const;

export type SupportedOrganization =
  (typeof organizationNames)[keyof typeof organizationNames];

export function hasOrganizationSelection(env: Env) {
  return env.USE_DOOMFORGE_ORG !== undefined || env.USE_180DC_ORG !== undefined;
}

export function activeOrganization(env: Env): string {
  if (!hasOrganizationSelection(env)) {
    const legacyOrganization = env.ORG_NAME ?? organizationNames.doomForge;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(legacyOrganization)) {
      throw new Error('ORGANIZATION_SELECTION_INVALID');
    }
    return legacyOrganization;
  }

  const doomForge = env.USE_DOOMFORGE_ORG;
  const vitc = env.USE_180DC_ORG;
  if (
    (doomForge !== 'true' && doomForge !== 'false') ||
    (vitc !== 'true' && vitc !== 'false') ||
    doomForge === vitc
  ) {
    throw new Error('ORGANIZATION_SELECTION_INVALID');
  }

  return doomForge === 'true'
    ? organizationNames.doomForge
    : organizationNames.vitc;
}

export function competitionRepositories(organization: string) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(organization)) {
    throw new Error('ORGANIZATION_SELECTION_INVALID');
  }
  return [
    `${organization}/mazhai-cover`,
    `${organization}/pricingpulse`,
    `${organization}/veera-footwear`,
    `${organization}/janus`,
  ] as const;
}

// Before dual-app mode the matrix competition allowlist was always the four
// Doom-Forge repositories, even in legacy deployments whose ORG_NAME names a
// different organization. Keep that behavior for unflagged deployments.
export function competitionOwner(env: Env): string {
  return hasOrganizationSelection(env)
    ? activeOrganization(env)
    : organizationNames.doomForge;
}

export function competitionRepositoriesFor(env: Env) {
  return competitionRepositories(competitionOwner(env));
}
