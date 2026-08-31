# Privileged Action Foundation

Task #009 stores approval requests for future operations such as service control, process termination, software installation, patching, and remote commands. These are identifiers only.

Requests are tenant-owned, device ownership is resolved server-side, and the default state is `PENDING_APPROVAL`. Approval requires the `privileged_actions.approve` permission and, when two-person approval is required, a different user from the requester. Expired, rejected, cancelled, or already-approved requests cannot transition again.

The API provides request, list, detail, approve, reject, and cancel operations. There is deliberately no execute endpoint, command queue, Agent polling, dispatch, output, or Windows state change in this release.
