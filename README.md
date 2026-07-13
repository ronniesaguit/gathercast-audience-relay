# GatherCast Audience Relay

This repository contains only the GatherCast internet audience relay.

Render settings:

- Service type: Web Service
- Runtime: Docker
- Dockerfile path: `Dockerfile`
- Plan: Free
- Health check path: `/api/relay/health`

Or use the included Blueprint:

- Blueprint file: `render.yaml`
- Region: Singapore
- Service name: `gathercast-audience-relay`

Environment variables:

```text
GATHERCAST_RELAY_HOST_KEY=<private teacher host key>
GATHERCAST_RELAY_ALLOWED_ORIGIN=*
```

`GATHERCAST_RELAY_PUBLIC_URL` is optional on Render. If omitted, the relay builds watch links from the Render request host.

The host key is private. Students only receive the generated watch link.
