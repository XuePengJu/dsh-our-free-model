# Network and privacy boundaries / 网络与隐私边界

本页根据当前源码列明客户端的出网类别与触发条件，不是网关运营方的留存政策，也不把静态核对冒充抓包或安全审计。README 中英文隐私摘要均链接到这里。

This page describes client behavior established by source inspection on 2026-11-27. It is a categorized map, not an exhaustive host allowlist: user-defined endpoints, installed extensions and third-party account services can add destinations. The source links below are the verification entry points. No live account, model request, credential import or traffic capture was used for this documentation change.

## What receives a model payload

The adapter selects a sender for the selected model lane. An EAC model goes through the EAC sender, a Kilo model through Kilo, and a configured aggregate model through its resolved provider. Other model integrations have their own sender paths. This branching does not establish a second EAC copy of requests sent on every other lane. EAC's sender serializes that EAC turn's request body and posts it to the gateway's `/chat/completions`; the gateway can see its prompts, context, tool results and attached images before forwarding it to the model provider.

Retries, continuation/recovery and configured fallback chains can send subsequent model requests. Request shaping can alter the payload before it is sent. Enabled extensions can participate in request hooks within their declared permissions. A configured egress proxy, proxy environment variables or a network extension can also be part of the transport path. Choosing a provider is therefore not a guarantee of a direct connection with no intermediary.

Verification: [`src/adapter.js`](../src/adapter.js) (`request` lane branch and `postSealedTurn`), [`src/eac.js`](../src/eac.js) (`postSealedStreamed`), [`src/aggregate.js`](../src/aggregate.js) (`resolveProvider` and poster), [`src/combos.js`](../src/combos.js), [`src/egress.js`](../src/egress.js), [`src/extensions.js`](../src/extensions.js).

## Other network activity

| Category | Destinations established in source | Trigger and data boundary |
| --- | --- | --- |
| Keyless model listings and inference | `opencode.ai` and `api.kilo.ai` by default | Catalog refresh and selected model requests use the corresponding lane. Listing requests differ from generation requests; a model's presence is not proof of current access. |
| EAC catalog and authorization | The gateway unlocked by the installed artifact; GitHub authorization flow | EAC availability, listing and login use the gateway. Authorization uses gateway start/poll/ack routes and a per-user token; an EAC model request sends its model payload. Package sealing can be extracted by an installer and does not provide a retention policy. |
| Announcement feed | This repository's `feed/announcements.json` via raw GitHub, jsDelivr and `gh-proxy.com`; a configured `feedUrl` can name another permitted URL | Unmanaged plugin installs poll on the configured feed cadence and support manual refresh. These are metadata requests, not a blanket upload of the local dashboard. The configured destination receives a network request and its normal connection metadata. |
| Plugin update checks and files | raw GitHub, `cdn.jsdelivr.net`, `gcore.jsdelivr.net`, `gh-proxy.com`; GitHub API/git/Atom commit-resolution paths | Self-managed installs schedule checks unless `updateCheckHours` is zero; managed installs skip the plugin's update checks. Installing an update is a separate operation. Artifact downloads use manifest/hash/signature verification. A valid project signature authenticates the project's artifact, not an official upstream Magpie release. |
| Extension market | `Ebony-Vinyl/ofm-extensions` registry and signature through raw GitHub, both jsDelivr edges and `gh-proxy.com`, unless overridden | Plugin startup and six-hour ticks request a refresh; a fresh cache can avoid network access and mirrors are attempted in order. Installing extension code is separate; automatic extension updates require their own setting. File/cover downloads and enabled extensions have additional permission-controlled paths. |
| Egress IP/country | `api.ipify.org`, `ipinfo.io`, `ipapi.co` | Startup/refresh/watch paths request the machine's public IP and, where available, country; the watch runs every two minutes in the plugin. The echo service observes the exit IP. These requests are not model turns. |
| Aggregate providers | The enabled provider's registry endpoint or the user's Base URL override | Inference, Test and Discover contact the resolved provider. API keys are sent as that provider's authentication; redaction of management output does not mean the key never leaves the machine. A registry entry alone does not enable it. |
| Imported subscriptions | `chatgpt.com`, `auth.openai.com`, `api.anthropic.com`, `cloudcode-pa.googleapis.com`, `oauth2.googleapis.com`; user endpoints for generic API subscriptions | Explicitly imported accounts can be used for inference and quota actions; token refresh occurs when needed. These paths send the imported account's authentication to the provider. Empty initial account storage is not an automatic import of native CLI accounts. |
| Built-in account channels | Each supported channel's login, quota/credit and model endpoints | The channel pack mounts when its required host services exist; login/import, account actions and selected inference use that channel's services. Local account pools are supported. Mounting the pack does not establish that an account is logged in or that every provider receives inference. |
| Optional outlet subscriptions and recommendations | Configured proxy/subscription services; `api.github.com` repository-stat endpoints | An enabled outlet can fetch its subscription and perform configured proxy health checks. The recommendations view refreshes cached repository statistics through GitHub; opening a linked website is a separate browser action. |

Verification: [`src/feed.js`](../src/feed.js), [`src/updater.js`](../src/updater.js), [`src/extensions.js`](../src/extensions.js), [`src/probe.js`](../src/probe.js), [`src/subscriptions.js`](../src/subscriptions.js), [`src/picks.js`](../src/picks.js), [`src/eac-login.js`](../src/eac-login.js), [`index.js`](../index.js), [`vendor/channel-pack/NOTICE.md`](../vendor/channel-pack/NOTICE.md), and the channel pack's source tree. Specific hosts can change with configuration or upstream service changes.

## Native CLI credential discovery and local storage

The subscription sidecar starts with an empty account list unless its own private store already contains imported accounts. Constructing it does not call native discovery. The `discover()` and `importLocal()` operations read only these known native credential locations under the configured home directory:

- Codex: `~/.codex/auth.json`
- Claude Code: `~/.claude/.credentials.json`
- Gemini CLI: `~/.gemini/oauth_creds.json`

Discovery parses local files to report candidate providers; local import is a separate action that copies the chosen account into the sidecar. In the plugin UI the discovery action is a button. The standalone subscription view requests discovery when that view becomes active, then presents separate import buttons. These facts do not justify a claim that every plugin start imports or transmits native CLI credentials. They also do not establish behavior for every third-party CLI or the embedded engine's own integrations.

The plugin's own stores live under `DSH_HOME/our-free-model/`; the standalone service uses its own data directory by default. Private settings/credential files use permission-restriction code, while features requiring authentication send the relevant credentials to their service. Management responses redact keys/tokens or expose presence/fingerprints rather than the raw secrets. Anyone able to read the local files is within the local trust boundary. A local forwarding key and a LAN relay key are distinct; the LAN relay exchanges its key for the local key at ingress.

Verification: [`src/subscriptions.js`](../src/subscriptions.js) (`NATIVE`, constructor, `discover`, `importLocal`, `resolve`, quota/token paths), [`client.js`](../client.js) (subscription discovery button), [`packages/standalone/frontend/agents.tsx`](../packages/standalone/frontend/agents.tsx), [`src/forward.js`](../src/forward.js), [`src/open-external.js`](../src/open-external.js).

## What remains unverified

Client source does not establish an operator's access logs, body logs, retention period, training use, subprocessors, jurisdiction or deletion procedure. Those EAC/operator policies still need a statement from the responsible operator. This change does not verify an installed Windows executable's Authenticode signature or independently reproduce the Magpie binary. The engine's pinned source, local patch, build recipe and hashes are documented in [`vendor/magpie/engine.json`](../vendor/magpie/engine.json), [`vendor/magpie/NOTICE.md`](../vendor/magpie/NOTICE.md) and [`scripts/build-magpie-engine.mjs`](../scripts/build-magpie-engine.mjs); hashes identify bytes, while the project's signing key remains the update trust anchor.

Issue #947 contains claims about a particular older install. The current source establishes the dispatch and discovery boundaries above; it does not prove or disprove every observation on that machine. That issue should remain open for the missing operator policy, artifact-specific signature/build evidence and any additional runtime evidence.
