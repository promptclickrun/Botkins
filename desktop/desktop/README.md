# Run Botkins on a headless server with a virtual display

For a server with no screen, use the terminal host. It needs no Electron and no display, and you install and operate it from a terminal. See [Run Botkins from a terminal](../docs/terminal.md).

The setup on this page is for a phone that must see and control a screen on the server. It runs Electron on a virtual display. It is the Compose profile `display`.

From the `desktop` folder, run `docker compose --profile display up --build -d host workspace`. Name the two services each time you start them: the same file also holds the terminal host (`botkins`), which a `docker compose up` without names starts too. For the other Compose commands (`ps`, `logs`, `exec`, `down`), put `COMPOSE_PROFILES=display` in `.env` or give `--profile display`. Compose starts the phone link and a separate Electron workspace on an Xvfb display with Openbox. By default, the link listens on the server's loopback interface at port 59851. An iOS Simulator on the same Mac can use that address.

To run beside an installed Botkins host on the same computer, use a different port and project name. For example, `BOTKINS_BIND_PORT=59853 docker compose -p botkins-smoke --profile display up --build -d host workspace` creates its own volumes. Use the same project name in subsequent Compose commands.

For a phone on your network, set the bind address and the address the phone can reach in the repository's `.env` before starting Compose. For example, if your server's LAN address is 192.168.1.20, use the following settings.

```dotenv
BOTKINS_BIND_ADDRESS=192.168.1.20
BOTKINS_BIND_PORT=59851
BOTKINS_PAIR_ADDRESS=192.168.1.20:59851
BOTKINS_HOST_NAME=Studio server
```

### Pair and use the screen

1. On first start, the host opens a short-lived pairing code. Read it in your server terminal with `docker compose exec host cat /run/botkins-owner/pairing.json`. In the phone's pairing screen, enter the advertised address and code, or open the pairing URL on the phone. The code and URL are private.
2. To pair another phone or replace an expired code, run `docker compose kill -s SIGUSR2 host` and read the file again.
3. In the paired phone's screen settings, choose **View**. Confirm with the phone's biometric or passcode prompt and open the screen. Choose **Control** and confirm again to click or type on the virtual display. **Off** takes effect immediately for all paired devices. The chosen mode survives restarts. A phone paired before presence-key enrollment needs to pair again to enable viewing or control.

The phone reports whether the virtual display is available and which device last changed access. If the display is unavailable, run `docker compose ps` and `docker compose logs workspace`. To stop both services and keep their data, run `docker compose down`. The workspace and the phone link have separate persistent volumes.

### How consent works

The public `host` service owns the pairing credentials and the saved screen level in `/var/lib/botkins-link/link.json`. It accepts a grant only over a direct, sealed session with a paired phone. It checks a single-use, 60-second challenge signed by the presence key enrolled during pairing. The signature binds the host, phone, requested level and ticket. Desktop clients, the relay and the ordinary workspace RPC have no grant operation.

A server in the cloud may have no network that a phone can join: phones reach it only through a relay that runs on the server itself. For that case, set `BOTKINS_RELAY_URL` to that relay and `BOTKINS_RELAY_OWN=1` on the `host` service. The host then keeps the presence key of a phone that paired through that relay, and accepts the same signed grant through it. The relay itself cannot make a grant, because it carries only sealed messages. The [Azure deployment](../../deploy/azure/README.md) with Screen access does this. On any other relay the host accepts a grant only directly.

The phone and host message shapes are documented in the [link contract](link/CONTRACT.md).

Electron, model tools and their shell processes run in the `workspace` service. That service owns the X11 display and answers capture and input requests on a Unix socket. Only the public host can read the owner pairing file and write the link volume. Docker operators control both services. Keep the Docker socket, host home directory and link volume outside the workspace container.

### Linux tarball updates

A systemd host can install signed updates through Settings → About or the agent update tool. Configure its fixed updater unit once using the [Linux setup instructions](linux-service/README.md). The same files ship in the Linux tarball under `resources/app/desktop/linux-service`.
