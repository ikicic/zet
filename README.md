# ZET live map

Displays live positions of ZET trams and buses on a map of Zagreb.

## Running locally

Set up a Python virtual environment and run the frontend server with:

```
make
cd web
make
npm run start
```

In another terminal, from the repository root folder, run a server that fetches
the live data:

```
./venv/bin/python -m zet.fetcher.fetcher
```

In yet another terminal, open the HTTP server:

```
ZET_DEV=1 ./venv/bin/python -m zet.webserver.webserver
```

Then, open http://localhost:3000/

To test feedback without sending email, set
`ZET_LIVE_FEEDBACK_FILE=/tmp/zet-feedback.txt` when starting the HTTP server
(keep your usual arguments for local data). Submitted messages and optional
reply addresses are appended to this UTF-8 text file. This setting overrides
SMTP delivery. Without it, feedback requires `ZET_LIVE_SMTP_HOST`,
`ZET_LIVE_SMTP_USER`, `ZET_LIVE_SMTP_PASS`, and `ZET_LIVE_FEEDBACK_EMAIL`;
`ZET_LIVE_SMTP_PORT` defaults to 587.

## Sources

https://www.zet.hr/odredbe/datoteke-u-gtfs-formatu/669

https://www.zet.hr/gtfs-rt-protobuf
