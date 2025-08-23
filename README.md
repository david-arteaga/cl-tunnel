### Cloudflare Quick Tunnel CLI (`cl-tunnel`)

A thin, opinionated wrapper around `cloudflared` to quickly manage ingress rules for a single Cloudflare Tunnel and map subdomains to local services.

### Quick example

Assuming you’ve initialized the CLI with `example.com`:

Map `api.example.com` to `http://localhost:3000` (supports http and web socket traffic by default):

```bash
cl-tunnel add api 3000
```

You can then access: `https://api.example.com` (after DNS propagation) which will be proxied to `http://localhost:3000`.

**Note**: Only single-level subdomains are supported (e.g., `api.example.com`). Nested subdomains like `dev.api.example.com` are not supported because Cloudflare only issues default SSL certs for one-level subdomains.

## Installation

### 1. Prerequisites

1. Install `cloudflared` (or [see Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/))

```bash
brew install cloudflared
```

2. Login

```bash
cloudflared tunnel login
```

3. Create a tunnel

```bash
cloudflared tunnel create <tunnel-name>
```

Example:

```bash
cloudflared tunnel create local-dev-mac-tunnel
```

- This will create the required credentials file and write your Cloudflare Tunnel config under `~/.cloudflared/`.

### 2. Install the CLI

#### Install via npm/yarn/pnpm/yarn (global)

```bash
npm install -g cloudflare-quick-tunnel
```

This package ships a single-file Bun-compiled executable at `dist/cl-tunnel` and exposes it via the npm `bin` field.

### 3. macOS service install (one-time)

Run the CLI to install and patch the `cloudflared` launch agent so it runs the tunnel reliably on macOS login:

```bash
cl-tunnel install-service
```

What this does:

- Runs `cloudflared service install` which creates `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`.
- Patches the plist to execute `cloudflared tunnel run` (not just `cloudflared`), then restarts the launch agent.

Why the patch? There’s a long-standing macOS issue where the service may start without `tunnel run`. See the discussion here: [cloudflared issue #327](https://github.com/cloudflare/cloudflared/issues/327).

If you prefer Cloudflare’s official guidance on running as a service, refer to [Cloudflare’s official guidance on running as a service](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/run-tunnel/run-as-service/).

### 4. Initialize the CLI config

Tell `cl-tunnel` which root domain you’ll be using for subdomains:

```bash
cl-tunnel init <your-root-domain>
# example:
cl-tunnel init example.com
```

This writes `~/.cl-tunnel/config.json` with your domain. The CLI will combine this with your `cloudflared` config to manage ingress.

## Usage

### Map subdomains to local ports

- **Add a mapping**: creates/updates an ingress rule and a DNS record for the subdomain.

```bash
cl-tunnel add <subdomain> <port>
# example: api.example.com -> http://localhost:3000
cl-tunnel add api 3000

# overwrite existing mapping if it exists
cl-tunnel add api 4000 --force
```

- **List mappings**:

```bash
cl-tunnel list
```

- **Remove a mapping** (removes the ingress rule; DNS removal is not yet automated):

```bash
cl-tunnel remove <subdomain>
```

---

## What `cl-tunnel add` does (under the hood)

When you run `cl-tunnel add <subdomain> <port>`, the CLI performs the following steps:

- Reads CLI config `~/.cl-tunnel/config.json` to get your root domain (e.g., `example.com`).
- Reads Cloudflare Tunnel config `~/.cloudflared/config.yml` and validates its shape.
- Appends or updates an ingress rule in `~/.cloudflared/config.yml`:
  - Adds `hostname: <subdomain>.<domain>` with `service: http://localhost:<port>`
  - Sorts rules (hostnamed rules first, alphabetically) and de-duplicates by hostname
  - Keeps your fallback rule (e.g., `- service: http_status:404`) last
- Writes the updated YAML back to `~/.cloudflared/config.yml`.
- Validates the config using `cloudflared`:

```bash
cloudflared tunnel ingress validate
```

- If validation fails, the CLI restores the previous file contents (rollback) and exits.
- Creates a DNS route for the subdomain to your tunnel UUID from the config:

```bash
cloudflared tunnel route dns <tunnel-uuid> <subdomain>
```

- If DNS routing fails, the CLI restores the previous config and exits.
- Restarts the macOS launch agent to apply changes:

```bash
launchctl kickstart -k gui/$(id - u)/com.cloudflare.cloudflared
```

- If restart fails, the CLI restores the previous config, then restarts again to return to the prior state.

Notes:

- DNS record removal is not automated by `remove` yet.

### Helpful Cloudflare docs

- [Install and setup](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) `cloudflared`
- Run as a service: [Cloudflare’s official guidance on running as a service](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/run-tunnel/run-as-service/)
- macOS service caveat: [cloudflared issue #327](https://github.com/cloudflare/cloudflared/issues/327)
