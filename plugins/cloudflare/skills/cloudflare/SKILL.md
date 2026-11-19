---
name: cloudflare
description: Operate Cloudflare Pages and DNS through one fail-closed profile. Use for deploying a folder to a Pages project, attaching a domain, DNS records, zones and account identity.
---

# Cloudflare

This plugin does Pages and DNS only, through the `pages-dns` profile: account identity, zones, DNS
and Pages, including writes. There is no token-creation tool, and nothing can delete anything.
`CLOUDFLARE_PROFILE` may be left unset or set to `pages-dns`; any other name stops the server.

A tool absent from your session means the server did not start. `cf_whoami` shows whether the token
is the problem.

## Credentials

The person sets these in the environment Claude Code starts in. The tools read them; you never handle a value.

| Variable | What it is |
|---|---|
| `FABRIK_SECRETS` | A folder holding `cloudflare.json`, readable by its owner only (mode 600). When set, nothing else is read. |
| `CLOUDFLARE_CONFIG_DIR` | The folder to use when `FABRIK_SECRETS` is not set. The default is `~/.config/fabrik-cloudflare`. |
| `CLOUDFLARE_API_TOKEN` | The token, used when `FABRIK_SECRETS` is not set. Without it, `cloudflare.env` in the settings folder holds `CLOUDFLARE_API_TOKEN=...`. |
| `CLOUDFLARE_CONTENT_ROOT` | The one absolute folder the tools may read local files from. Required by `cf_pages_deploy`. |
| `FABRIK_WRANGLER` | The absolute path of a Wrangler install's `node_modules/wrangler/bin/wrangler.js`. Required by `cf_pages_deploy`. |
| `CLOUDFLARE_PROFILE` | `pages-dns`, which is also the default. |

`cloudflare.json` holds `version` (1), `apiToken`, `accountId`, `accountName` and `connectedAt`, and nothing else.

If `cf_whoami` reports no credential, say Cloudflare is not connected and name these variables.

**Never ask for a token in chat, and never accept one that is offered.** A token pasted into the conversation is written to the transcript before anything can stop it, and the transcript is a permanent file. If one arrives anyway, say plainly that it is now in the conversation record, that you are not using it, and that they should roll it in the dashboard. Do not repeat the value back. The tools read credentials themselves; you never handle the value.

## Start with `cf_whoami`

It verifies the token and reports which account it can see. When anything is refused, run it first: it separates a token that is wrong from a token that is merely scoped too narrowly, and those send the operator to different places.

If the token can see more than one account, the secure connection command asks the operator to
choose a numbered account name without requiring them to find or type an account ID.

## What the tools cover

| Area | Tools |
|---|---|
| Account | `cf_whoami` |
| Zones and DNS | `cf_zones_list`, `cf_zone_for_hostname`, `cf_dns_list`, `cf_dns_upsert` |
| Pages | `cf_pages_projects_list`, `cf_pages_project_create`, `cf_pages_domain_add`, `cf_pages_deploy` |

## How the tools answer

Every tool returns the same envelope: `ok`, `result`, `problem`. A refusal is a result, not a crash — `problem` carries Cloudflare's own sentence about why, because two different refusals send the operator to different places. Relay that sentence rather than paraphrasing it into "something went wrong".

## Things worth knowing before you call

**Publishing a site is two steps.** `cf_pages_project_create` first, then `cf_pages_deploy`. Deploying to a project that does not exist fails in a way that reads as an auth error. To put it on the operator's own domain, `cf_pages_domain_add` after the first successful deploy.

`cf_pages_deploy` uploads with the Wrangler that `FABRIK_WRANGLER` names, and no other. If it is unset or wrong,
say so and name the variable.

**A site with form handlers is deployed with `root` as well as `directory`.** Pages takes
`functions/` and `wrangler.toml` from where Wrangler runs, not from the files it uploads, and an
artifact keeps them beside the published directory rather than inside it — everything inside is
served. So pass `directory` as the published directory and `root` as the artifact root that holds
the handlers. Omitting `root` on a form-bearing artifact deploys the pages and silently no
handlers: the site comes up and every submission 404s.

**DNS writes are idempotent.** `cf_dns_upsert` updates a matching record in place rather than creating a second one, so re-running it converges. It resolves the zone by longest matching suffix, so a host under a delegated subdomain zone lands in that zone and not its parent.

Before deployment, verify the artifact manifest and checksum. Preview branches are the default;
production requires an explicit operator request for the selected artifact. Report the previous
observable state and rollback instructions after every mutation.

## Scope

In scope: the operations listed above, against one Cloudflare account and artifacts under
`CLOUDFLARE_CONTENT_ROOT`.

Out of scope, deliberately: token creation, deletes, D1, R2, tunnels, Access, driving the dashboard,
completing consent pages and building source.
