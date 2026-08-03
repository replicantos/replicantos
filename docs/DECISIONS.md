# Decision Log

## Product and release decisions

These decisions define the public v0.1 product and release boundary. A later release may revisit them through an explicit decision and migration rather than by implying support that does not exist.

| Decision            | Public v0.1 choice                                                                           | Status    |
| ------------------- | -------------------------------------------------------------------------------------------- | --------- |
| Deployment model    | One free, open-source, self-hosted workspace per installation; no hosted ReplicantOS service | Confirmed |
| Storage             | SQLite/WAL only; PostgreSQL is not supported                                                 | Confirmed |
| Primary platform    | Ubuntu production; macOS development and local evaluation                                    | Confirmed |
| Client              | Responsive PWA; native mobile deferred                                                       | Confirmed |
| External transports | Internal web channels; external transports deferred                                          | Confirmed |
| Terminal            | Capability gate reserved; browser terminal deferred                                          | Confirmed |
| Harness credentials | Provider-supported host credential mechanisms; ReplicantOS stores no provider credential     | Confirmed |
| Telemetry           | No application telemetry pipeline                                                            | Confirmed |
| Public website      | `replicantos.com` is a static marketing, documentation, and installation site only           | Confirmed |
| Landing deployment  | Vercel static deployment at `replicantos.com`                                                | Confirmed |
| Public repository   | `github.com/replicantos/replicantos`                                                         | Confirmed |
| Project email       | `admin@replicantos.com`                                                                      | Confirmed |
| License             | MIT                                                                                          | Confirmed |
| Harness maturity    | Codex and the optional Claude adapter are stable; OpenCode and Grok Build are beta           | Confirmed |
