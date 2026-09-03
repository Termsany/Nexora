# Nexora RBAC

Authorization is default-deny and is evaluated by the centralized tenancy policy. A permission never grants access to an organization by itself; the request must also have a valid membership or platform scope.

| Role | Scope | Capabilities |
| --- | --- | --- |
| PLATFORM_SUPER_ADMIN | Platform | All defined permissions, including security and privileged-action approval |
| PLATFORM_ADMIN | Platform | Customer, operational, membership, notification, audit, and privileged-action administration; no super-admin-only user security escalation |
| PLATFORM_TECHNICIAN | Platform | Operational read, alert acknowledgement, audit/session read, and privileged-action requests |
| ORGANIZATION_ADMIN | Assigned organizations | Operational management, members, enrollment tokens, audit, sessions, and privileged-action request/approval |
| ORGANIZATION_TECHNICIAN | Assigned organizations | Operational read, alert acknowledgement, audit/session read, and privileged-action requests |
| ORGANIZATION_VIEWER | Assigned organizations | Operational read and own-session management only |

Unknown roles, permissions, users, memberships, or missing tenant context are denied. Suspended users and suspended organizations cannot authenticate for organization access.
