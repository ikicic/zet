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

## Sources

https://www.zet.hr/odredbe/datoteke-u-gtfs-formatu/669

https://www.zet.hr/gtfs-rt-protobuf
