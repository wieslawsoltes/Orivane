# Upgrade from 0.1 to 0.2

1. Export important local boards as Orivane JSON. Stop the old server and copy/protect the complete server data directory. Do not overwrite the only working backup.
2. Extract this release separately. Use Node 22.16 or newer, run `npm test`, and review `.env.example` and SECURITY.md.
3. Start one 0.2 server pointing at the existing data directory, or migrate the stopped directory into empty shared storage with the admin tool. Legacy room JSON is read by the new store; v1 document snapshots are accepted.
4. Reload **all** clients onto the 0.2 app. New actor secrets, character operations and `orivane/2` snapshots are not a compatible mixed-version collaborative session with 0.1.
5. Open saved boards, verify editing and viewer links, create a new test room, and run diagnostics on the actual localhost/HTTPS origin. Back up the upgraded data before enabling external providers or wider access.

Existing guest rooms do not automatically become private workspace boards. Sign in, create a workspace and use its Publish action to create an account-backed copy. Workspace guest access is separately controlled. Account credentials/provider tokens are not included in a portable board export.

Named server restore is collaborative: it creates new operation stamps. Restoring raw server backups is an offline administrator procedure and can restore old authorization/session state as well as documents. Roll back by restoring the untouched 0.1 backup **and** old server/clients; do not point 0.1 at already-upgraded data and assume reverse compatibility.

New formats are conversion tools, not lossless substitutes for Orivane JSON. Keep the original native files and review warnings before importing. Rich formatting and workshop/history data do not round-trip through every external format.
