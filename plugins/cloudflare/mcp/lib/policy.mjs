const PAGES_DNS = [
  "cf_whoami",
  "cf_zones_list",
  "cf_zone_for_hostname",
  "cf_dns_list",
  "cf_dns_upsert",
  "cf_pages_projects_list",
  "cf_pages_project_create",
  "cf_pages_domain_add",
  "cf_pages_deploy",
];

const PROFILES = new Map([
  ["pages-dns", new Set(PAGES_DNS)],
]);

export const PROFILE_NAMES = [...PROFILES.keys()];

export function toolsForProfile(tools, profile = process.env.CLOUDFLARE_PROFILE) {
  const selected = profile?.trim() || "pages-dns";
  const allowed = PROFILES.get(selected);
  if (!allowed) {
    throw new Error(
      `Unknown CLOUDFLARE_PROFILE: ${selected}. This connector fails closed.`,
    );
  }
  return tools.filter(tool => allowed.has(tool.name));
}
