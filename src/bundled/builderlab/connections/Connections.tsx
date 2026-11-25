import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PlusIcon,
  PlugIcon,
  WarningCircleIcon,
} from "../../../shared/design-system/icons";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../../shared/design-system/ui/Avatar";
import { Button } from "../../../shared/design-system/ui/Button";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { SearchField } from "../../../shared/design-system/ui/SearchField";
import type { BuilderlabSession } from "../session";
import type { Connection } from "./client";
import {
  connectionLabel,
  connectionStatus,
  sortConnections,
  type ConnectionStatus,
} from "./status";
import type { ConnectionsStore } from "./store";
import styles from "./Connections.module.css";

/** Past this many, a search narrows the list. */
const SEARCH_FROM = 8;

function StatusText({ status }: { status: ConnectionStatus }) {
  return status.kind === "expired" ? (
    <span className="text-danger">Expired</span>
  ) : status.kind === "expiring" ? (
    <span className="text-warning">{status.label}</span>
  ) : (
    <span className="text-subtle">Connected</span>
  );
}

export function Connections({
  store,
  session,
  active,
  openPage,
  focused = false,
  now = Date.now,
}: {
  store: ConnectionsStore;
  session: BuilderlabSession;
  active(): boolean;
  /** The account's connections page, or one connection's sign-in there. */
  openPage(name?: string): void;
  /** Scrolled into view on arrival, as from an expiry notification. */
  focused?: boolean;
  now?: () => number;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const section = useRef<HTMLElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const signedIn = login.status === "signed-in";
  useEffect(() => {
    if (focused && signedIn) section.current?.scrollIntoView?.();
  }, [focused, signedIn]);
  // Coming back from the browser re-reads, so a reconnect shows at once.
  useEffect(() => {
    if (!signedIn) return;
    const focus = () => {
      if (activeRef.current()) void store.refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [store, signedIn]);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  if (!signedIn) return null;
  const at = now();
  const all = state.connections
    ? sortConnections(state.connections, at)
    : undefined;
  const needed =
    all?.filter((c) => connectionStatus(c, at).kind !== "connected").length ??
    0;
  const search = query.trim().toLowerCase();
  const shown = search
    ? all?.filter((c) => connectionLabel(c.name).toLowerCase().includes(search))
    : all;
  return (
    <section
      ref={section}
      aria-labelledby="builderlab-connections"
      className="flex flex-col gap-3"
    >
      <InlineHeader
        id="builderlab-connections"
        title="Connections"
        subtitle="Apps and services your agents use on your behalf. Reconnect one before it expires to keep them working."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              if (active()) openPage();
            }}
          >
            <PlusIcon aria-hidden="true" /> Add connection
          </Button>
        }
      />
      {needed > 0 && (
        <p role="status" className={`${styles.attention} text-body-sm`}>
          <WarningCircleIcon aria-hidden="true" size={16} />
          {needed === 1
            ? "1 connection needs attention"
            : `${needed} connections need attention`}
        </p>
      )}
      {(all?.length ?? 0) > SEARCH_FROM && (
        <SearchField
          value={query}
          onValueChange={setQuery}
          label="Search connections"
          placeholder="Search connections"
        />
      )}
      {!all && !state.error && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          Loading connections…
        </p>
      )}
      {state.error && (
        <div role="alert">
          <EmptyState
            icon={<PlugIcon />}
            title="Couldn’t load connections"
            description={state.error}
            action={
              <Button
                variant="subtle"
                loading={state.loading}
                onClick={() => void store.refresh()}
              >
                Try again
              </Button>
            }
            level={4}
          />
        </div>
      )}
      {all?.length === 0 && (
        <EmptyState
          icon={<PlugIcon />}
          title="No connections yet"
          description="Connect an app so your agents can use it."
          level={4}
        />
      )}
      {shown && shown.length > 0 && (
        <ul className={styles.list} aria-label="Your connections">
          {shown.map((connection) => {
            const status = connectionStatus(connection, at);
            const name = connectionLabel(connection.name);
            return (
              <li key={connection.name} className={styles.row}>
                <span className={styles.icon} aria-hidden="true">
                  <Avatar alt="" fallback={name} size="fill" shape="squircle" />
                </span>
                <span className={styles.name}>
                  <span className="text-body-sm">{name}</span>
                  <span className="text-caption">
                    <StatusText status={status} />
                  </span>
                </span>
                <span className={styles.actions}>
                  <Button
                    variant="ghost"
                    aria-label={`Disconnect ${name}`}
                    onClick={() => {
                      if (!active()) return;
                      setFailure(undefined);
                      setConfirm(connection);
                    }}
                  >
                    Disconnect
                  </Button>
                  <Button
                    variant={
                      status.kind === "connected" ? "ghost" : "prominent"
                    }
                    aria-label={`Reconnect ${name}`}
                    onClick={() => {
                      if (active()) openPage(connection.name);
                    }}
                  >
                    Reconnect
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {shown?.length === 0 && !!all?.length && (
        <p className="m-0 text-body-sm text-secondary">
          No connections match “{query.trim()}”.
        </p>
      )}
      {confirm && (
        <AlertDialog
          title={`Disconnect ${connectionLabel(confirm.name)}?`}
          description="Your agents lose access until you connect it again."
          pending={busy}
          onClose={() => setConfirm(null)}
          {...(failure ? { children: <p role="alert">{failure}</p> } : {})}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  setFailure(undefined);
                  store.disconnect(confirm.name).then(
                    () => {
                      setBusy(false);
                      setConfirm(null);
                    },
                    (reason) => {
                      setBusy(false);
                      setFailure(
                        reason instanceof Error
                          ? reason.message
                          : "Couldn’t disconnect.",
                      );
                    },
                  );
                }}
              >
                Disconnect
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
