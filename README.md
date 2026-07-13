# GatherCast Audience Relay

This repository contains only the GatherCast internet audience relay.

Render settings:

- Service type: Web Service
- Runtime: Docker
- Dockerfile path: `Dockerfile`
- Plan: Free
- Health check path: `/api/relay/health`

Environment variables:

```text
GATHERCAST_RELAY_HOST_KEY=<private teacher host key>
GATHERCAST_RELAY_PUBLIC_URL=https://<your-render-service>.onrender.com
GATHERCAST_RELAY_ALLOWED_ORIGIN=*
```

The host key is private. Students only receive the generated watch link.
