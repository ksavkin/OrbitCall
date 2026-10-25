# Production demo operator setup

Recorded October 25, 2026, for Convex production `basic-wildcat-552`.

The production catalog was present but `companies`, `users`, `satelliteOwners`,
`fleetAssignments`, `policies`, `candidateSets` and `demoRuns` were empty.

The initial setup now contains:

| Demo company | Language | Catalog object IDs | Policies |
| --- | --- | --- | --- |
| American Satellite Dynamics (`asd`) | English | 56191, 56193, 56200, 62382 | 4 |
| Sever Imaging (`sever`) | Russian | 64880, 64890, 57182, 57178 | 4 |
| Jade Orbit (`jade`) | Mandarin | 43023, 58646, 58647, 54686 | 4 |

All three companies are `simulated: true`. Their names, fleets, contact details
and policy values come from the existing frontend demo fixtures. Company
ownership is a demonstration assignment, not a claim about the real spacecraft
operators. Catalog objects retain their original source metadata. Initial mission
windows use October 25 as their UTC base, putting the sample day-one windows on
October 26. Operators can edit these policies once their accounts are connected.

Verified after setup: three companies, twelve ownership records and three policy
documents containing twelve satellite policies. All policies are revision 1, have
finite numeric values and ordered UTC windows. A subsequent read-only setup run
reports that it will preserve every existing policy.

## Remaining identity dependency

Users and fleet assignments remain empty until the real Auth0 User IDs are supplied.
The production tenant is `dev-ay53aq1il0o71m4d.us.auth0.com`. The deployed website's
public JavaScript contains the matching tenant/client configuration and the
`basic-wildcat-552` backend URL. The legacy cookie demo-login endpoint is also
configured, but its cookies do not authenticate a user to Convex.

Obtain each account's **User ID** from Auth0 → User Management → Users. Use one
distinct account for each dispatcher and another for the read-only observer.
Do not substitute an email address, local `demo-us` identifier, password or token.
The administrator must confirm that these are the intended existing accounts;
the setup script reads the tenant's issuer metadata but does not have Auth0
Management API access to create or look up users.

Create an ignored `.env.demo-operators.json` file, replacing the deliberately
invalid placeholders with the real IDs. `name` is optional.

```json
{
  "us": { "subject": "COPY_REAL_US_USER_ID" },
  "ru": { "subject": "COPY_REAL_RUSSIAN_USER_ID" },
  "cn": { "subject": "COPY_REAL_CHINESE_USER_ID" },
  "observer": { "subject": "COPY_REAL_OBSERVER_USER_ID" }
}
```

Preview, then apply using the authenticated Convex CLI session:

```sh
node scripts/provision_demo_operators.mjs --deployment basic-wildcat-552 --identities .env.demo-operators.json
node scripts/provision_demo_operators.mjs --deployment basic-wildcat-552 --identities .env.demo-operators.json --apply
```

`operators.provision` links the verified issuer plus each supplied subject to its
company and creates four active assignments for each dispatcher. The observer
belongs to the US demonstration company with role `demo_observer` and no fleet
assignments. Partial identity files are allowed, so the first dispatcher can be
connected without waiting for the others. Missing identities remain explicitly
unconfigured; the script never fabricates login identities.

## Initial policy bootstrap and safeguards

For a new empty deployment, the initial setup command is:

```sh
node scripts/provision_demo_operators.mjs --deployment DEPLOYMENT_NAME --bootstrap-policies
node scripts/provision_demo_operators.mjs --deployment DEPLOYMENT_NAME --bootstrap-policies --apply
```

The script is read-only unless `--apply` is supplied. It checks the catalog objects,
existing companies, ownership, accounts and assignments before writing. It refuses
company/account transfers and assignment revocations. Existing company settings and
policies are preserved. Provisioning uses the existing internal mutation; it does
not push a backend deployment.

The initial policies use an administrator-only, empty-table import. This is allowed
only before candidate sets, approvals or maneuvers exist. No `--append`, `--replace`
or `--replace-all` is used: Convex refuses an already populated policy table.
Existing operational policies must be changed through the authenticated policy UI
and its normal approval-invalidation path. Temporary import files are private and
removed after the attempt. There are no automatic retries.

Empty `candidateSets` and `demoRuns` are not account-seeding errors. A signed-in
assigned operator must start the appropriate scan/workflow or explicitly launch a
simulated satellite. This setup does not create proposals, launch a scenario,
record human approvals or schedule a maneuver.

After linking accounts, verify in separate browser sessions that each operator
sees four assigned objects and only their company's policy, and that the observer
has no decision controls. A database setup check alone is not a browser sign-in or
multi-user workflow rehearsal.
