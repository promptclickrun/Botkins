import { useEffect, useRef, useState } from "react";
import { Package, Search } from "lucide-react";
import { useAsk } from "./Pages";
import { shownText } from "../desktop/shown-text.mjs";
import { Group, SwitchRow, errorText } from "./SettingsRows";
import { teamCan } from "./teamAccess";
import type { InstalledPiPackage, PiPackageListing, State } from "./types";

const api = window.botkins;

export default function MarketPi({ state, refreshed }: { state: State; refreshed: number }) {
  const host = state.remote?.using;
  const supported = !host || host.capabilities.includes("pi-packages-v1");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<{ packages: PiPackageListing[]; nextPage?: number }>();
  const [installed, setInstalled] = useState<InstalledPiPackage[]>();
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(false);
  const dialogs = useAsk();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    setError("");
    api["piPackages.list"]().then(
      (list) => {
        if (live) setInstalled(list);
      },
      (e) => {
        if (live) setError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [supported, refreshed, revision]);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    setListing(undefined);
    setCatalogError("");
    const timer = setTimeout(() => {
      api["piPackages.browse"]({ query, page }).then(
        (next) => {
          if (live) setListing(next);
        },
        (e) => {
          if (live) setCatalogError(errorText(e));
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [supported, query, page, refreshed]);

  async function change(name: string, current?: InstalledPiPackage) {
    setBusy(name);
    setError("");
    try {
      const { version } = current ?? (await api["piPackages.preview"](name));
      const action = current ? "Turn on" : "Install and turn on";
      if (!alive.current) return;
      if (
        !current?.enabled &&
        !(await dialogs.ask({
          title: action + " " + name + "@" + version + "?",
          body:
            (current ? "" : "Pi will run pi install npm:" + name + "@" + version + ". ") +
            "This package can run code on " +
            shownText(host?.name || "this computer") +
            ". It will load on the next turn in every Botkins chat using Pi or OMP.",
          confirm: action,
        }))
      )
        return;
      if (!alive.current) return;
      if (current) await api["piPackages.setEnabled"](name, version, !current.enabled);
      else await api["piPackages.install"](name, version);
      setRevision((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  if (!supported) return <p className="set-status">Update the app on your computer to manage Pi packages.</p>;
  return (
    <>
      <Group title="Installed in Pi" footer="Changes apply on the next turn in every Botkins chat using Pi or OMP.">
        {installed?.map((pkg) => (
          <SwitchRow
            key={pkg.name}
            label={pkg.name}
            help={pkg.version + " · " + (pkg.enabled ? "On" : "Off")}
            checked={pkg.enabled}
            disabled={!!busy || !teamCan(state, "plugins", "manage")}
            onChange={() => void change(pkg.name, pkg)}
          />
        ))}
        {!installed?.length && (
          <p className="set-status">
            {installed ? "No Pi packages installed." : error ? "Installed packages unavailable." : "Loading installed packages…"}
          </p>
        )}
      </Group>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      <div className="set-toolbar int-toolbar plugin-toolbar">
        <label className="int-filter">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search Pi packages"
            placeholder="Search Pi packages"
            maxLength={200}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      <Group title="Pi package catalog">
        {catalogError ? (
          <p className="set-status error-text" role="alert">
            {catalogError}
          </p>
        ) : !listing ? (
          <p className="set-status">Loading Pi packages…</p>
        ) : !listing.packages.length ? (
          <p className="set-status">No Pi packages match.</p>
        ) : (
          listing.packages.map((pkg) => {
            const present = installed?.some((p) => p.name === pkg.name);
            const url = "https://pi.dev/packages/" + pkg.name;
            return (
              <div className="plugin-listing" key={pkg.name}>
                <span className="plugin-listing-icon">
                  <Package size={16} aria-hidden="true" />
                </span>
                <span className="plugin-listing-copy">
                  <strong>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        void api.openLink(url).catch((e) => setError(errorText(e)));
                      }}
                    >
                      {pkg.name}
                    </a>
                  </strong>
                  <small>{pkg.description}</small>
                  <em>{pkg.types.join(" · ")}</em>
                </span>
                {present ? (
                  <small>Installed</small>
                ) : (
                  teamCan(state, "plugins", "install") && (
                    <button
                      type="button"
                      className="set-button"
                      disabled={!installed || !!busy}
                      onClick={() => void change(pkg.name)}
                    >
                      {busy === pkg.name ? "Working…" : "Install"}
                    </button>
                  )
                )}
              </div>
            );
          })
        )}
        {(page > 1 || listing?.nextPage) && (
          <div className="set-actions">
            {page > 1 && (
              <button className="set-button" type="button" onClick={() => setPage(page - 1)}>
                Previous
              </button>
            )}
            {listing?.nextPage && (
              <button className="set-button" type="button" onClick={() => setPage(listing.nextPage!)}>
                Next
              </button>
            )}
          </div>
        )}
      </Group>
      {dialogs.node}
    </>
  );
}
