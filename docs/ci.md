# CI scope and final qualification

Pull requests select validation from the exact checked-out head and bounded, read-only GitHub Actions history.
Every package update runs static checks and builds its own package archive. No previous artifacts or local state supply validation results.
Documentation/website-only updates skip package jobs when complete bounded history proves no unresolved package attempt.
Missing history proof falls back to package qualification. Main documentation-only pushes use their exact before/head diff.

| Update after a proven full attempt            | Scheduled package jobs |
| --------------------------------------------- | ---------------------: |
| Changed test files, no unresolved failures    |                      6 |
| Ordinary TypeScript source changes            |                     10 |
| Test changes with an unresolved Windows shard |                      8 |
| Full qualification                            |                     25 |

Counts include change detection, static checks, Linux tests, platform tests, and acceptance.
Website validation adds one job when affected or unresolved. Release jobs are excluded.
The previous package matrix scheduled 24 jobs without the new acceptance job.
These are deterministic scheduling comparisons, not measured billable cost savings.

Test-only updates run the selected files on Linux, macOS, and Windows.
Ordinary source updates run complete Linux coverage and all six platform shards.
Packaging, native dependencies, configuration, workflow, selector, sharder, shared test helpers, and unknown paths require full qualification.
Full qualification includes all twelve consumer combinations and three native jobs.
Consumer and native failures rerun their specific supported combinations during later selected updates.

A full attempt can anchor history even when one scope failed.
Missing, cancelled, timed-out, unfinished, or skipped required scopes remain unresolved.
A targeted test pass cannot clear a full shard or Linux coverage failure.
A failure clears only when every requested checkpoint gate succeeds with identical selector, sharder, and workflow fingerprints.
An isolated job success in a failed or cancelled run cannot clear a failure; its source fix could later be reverted.
Website skips never clear a website failure.

Successful selected checkpoints advance only when every requested gate completed under the same configuration.
The next update then selects new changes plus unresolved scopes.
When checkpoint proof is unavailable, the selector keeps the cumulative diff from the full anchor.
Missing history, rebases, changed bases, ambiguous metadata, and inspection limits fall back to full qualification.

The selector inspects at most thirty recent workflow summaries and ten matching job lists.
It requires exact repository, head repository, branch, PR, base, ancestor, and configuration provenance.
Modern acceptance names encode the PR number, immutable base SHA, selection mode, and website scope.
This supports GitHub responses whose `pull_requests` association array is empty.
Legacy empty associations cannot establish provenance.
The token has read-only contents, pull request, and Actions permissions.

Selected runs explicitly leave full final acceptance pending.
Freeze the head, then run full exact-head qualification once before merge or release.
If that head already passed a full PR run, use that result instead of manually dispatching a duplicate.
Otherwise dispatch CI with `expected_sha` equal to the frozen commit.
Main package pushes, explicit dispatches, and release qualification retain the full matrix.
The existing automated release dispatch remains unchanged.

Selected paths travel through JSON environment values and validated argument arrays.
They are never interpolated into shell commands.
Partial Linux runs do not report full coverage.
