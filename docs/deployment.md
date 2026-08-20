# Deployment

The API and dashboard are portable Node services in this development
workspace, while the platform contract remains container-friendly. A
production deployment should provide PostgreSQL, set environment variables
from a secret manager, terminate TLS at the edge, and expose a stable DNS name
to agents. Moving between a generic Docker host, AWS, or Azure should require
infrastructure configuration and database migration, not source changes.