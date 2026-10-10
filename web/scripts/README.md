# Development scripts

## Tests

Run `make test` from the repository root for Python and graphics tests.
Requires Chrome/Chromium; set `CHROME_BIN` if the executable is not
`google-chrome`. To run only graphics tests: `cd web && npm run test:graphics`.

## Feedback delivery

Set `ZET_LIVE_FEEDBACK_FILE=/tmp/zet-feedback.txt` when starting the HTTP
server to save submissions locally instead of sending email.

For email, set `ZET_LIVE_SMTP_HOST`, `ZET_LIVE_SMTP_USER`,
`ZET_LIVE_SMTP_PASS`, and `ZET_LIVE_FEEDBACK_EMAIL`.
`ZET_LIVE_SMTP_PORT` defaults to 587.

## Vehicle-label stress test

With the frontend development server running, run `npm run stress-server`
from `web`, then open http://localhost:3000/?perf=1&stress=1.

A new vehicle label appears every two seconds while the map moves.
Set `STRESS_INTERVAL_MS` or `STRESS_MAX_VEHICLES` to change the defaults.
