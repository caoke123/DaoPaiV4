# DaoPai V3

DaoPai V3 is initialized from the stable DaoPai V2 baseline.

DaoPai V2 remains the current stable production tool and must not be modified from this project.

DaoPai V3 is the new SaaS direction:

- DaoPai Cloud Platform
- DaoPai Local Agent
- multi-tenant data isolation
- tenantId
- siteId
- workstationId
- cloud PostgreSQL
- local browser automation execution
- optional local/S3 screenshot strategy

## Fixed Local Ports

| Service | Port |
|---|---:|
| Frontend | 5176 |
| Backend | 3300 |
| PostgreSQL | 5436 |
| Redis | 6381 |

## Local Development

Backend:

```bash
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Frontend URL:

```text
http://localhost:5176
```

Backend URL:

```text
http://localhost:3300
```

## Important Notes

* Do not modify DaoPai V2 from this project.
* Do not rely on old V2 development reports, test reports, phase summaries, or troubleshooting documents as V3 requirements.
* V3 will move toward SaaS Cloud Platform + Local Agent architecture.
* V3-specific test scripts should be recreated later when needed.
