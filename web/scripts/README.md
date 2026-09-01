# Development scripts

## Vehicle-label stress test

With the frontend development server running, start the stress server from the
`web` directory:

```
npm run stress-server
```

Then open http://localhost:3000/?perf=1&stress=1. The server adds a vehicle
with a new route label every two seconds, while the development-only stress
mode moves the map continuously.

Set `STRESS_INTERVAL_MS` or `STRESS_MAX_VEHICLES` to change the defaults.
