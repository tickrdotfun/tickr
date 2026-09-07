# security

## reporting

If you find a vulnerability in the contracts, the site or the workers, report it privately through GitHub's
security advisories on this repository (Security, then Report a vulnerability). Please do not open a public
issue for anything exploitable. Include the contract or route, the steps, and what an attacker gains.

We answer within three days, keep you informed while we work, and credit you in the fix unless you prefer not.

## scope

- `contracts/src`: every deployed contract. The contracts are immutable per version; a confirmed bug is
  mitigated by closing new launches on the affected factory and deploying a new version, never by patching in place.
- `web/src`: the site, including the transaction builders and the `api` routes.
- `workers/tokens`: the token list and upload accounting Worker.

Out of scope: the coming-soon landing, third-party services the site reads (explorers, chart sites, IPFS
gateways), and anything that needs a compromised wallet or a malicious browser extension.

## what is checked before every change

Continuous integration (`.github/workflows/ci.yml`) builds the contracts with size limits and runs the unit, fuzz
and invariant suites, typechecks and lints the site, runs the offline transaction suites against golden router
bytes, audits dependencies, and builds the site. The fork suite against a live Robinhood Chain node runs before
every release. Outside review rounds and their closures are recorded in `docs/20-reference-alignment.md`.
