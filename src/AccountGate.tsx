import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { LogOut01, ArrowRight } from "@untitledui/icons";
import type { AccountProfile, AuthPublicConfig } from "../server/account-types";
import { setAccountSession } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { InlineError } from "./observation-ui";
import "./account.css";
type AccountContext = {
  enabled: boolean;
  profile?: AccountProfile;
  workspaceId: string;
  select: (id: string) => void;
  signOut: () => void;
  create: () => void;
  refresh: () => Promise<void>;
};
const Context = createContext<AccountContext>({
  enabled: false,
  workspaceId: "",
  select: () => {},
  signOut: () => {},
  create: () => {},
  refresh: async () => {},
});
export const useAccount = () => useContext(Context);
export function AccountControls({
  showWorkspace = true,
}: {
  showWorkspace?: boolean;
}) {
  const account = useAccount();
  if (!account.enabled || !account.profile) return null;
  return (
    <div className="account-controls">
      {showWorkspace && (
        <label>
          <span>Workspace</span>
          <select
            aria-label="Current workspace"
            value={account.workspaceId}
            onChange={(e) =>
              e.target.value === "__new__"
                ? account.create()
                : account.select(e.target.value)
            }
          >
            {account.profile.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value="__new__">Create workspace…</option>
          </select>
        </label>
      )}
      <div className="account-user">
        <span title={account.profile.user.email}>
          {account.profile.user.email}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={account.signOut}
        >
          <LogOut01 size={16} />
        </Button>
      </div>
    </div>
  );
}
export function AccountGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthPublicConfig>();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AccountProfile>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"signin" | "signup" | "reset" | "recover">(
    "signin",
  );
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState("");
  const [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [route, setRoute] = useState(location.hash);
  const client = useRef<SupabaseClient | null>(null),
    currentSession = useRef<Session | null>(null),
    version = useRef(0),
    creationKey = useRef(crypto.randomUUID());
  const activeWorkspace = useRef("");
  const routedAccount = useRef("");
  const select = (id: string) => {
    if (
      !profile?.workspaces.some((w) => w.id === id) ||
      !currentSession.current
    )
      return;
    setAccountSession(currentSession.current.access_token, id, profile.user.id);
    activeWorkspace.current = id;
    setWorkspaceId(id);
    try {
      localStorage.setItem("octolab.workspace." + profile.user.id, id);
    } catch {}
  };
  const clear = () => {
    version.current++;
    routedAccount.current = "";
    currentSession.current = null;
    activeWorkspace.current = "";
    setMode("signin");
    setAccountSession("", "", "");
    setSession(null);
    setProfile(undefined);
    setWorkspaceId("");
    setPassword("");
    setCreating(false);
  };
  const signOut = () => {
    clear();
    void client.current?.auth.signOut({ scope: "local" }).catch(() => {});
  };
  const loadProfile = async (value: Session) => {
    const request = ++version.current;
    try {
      const response = await fetch("/api/auth/me", {
          headers: { Authorization: "Bearer " + value.access_token },
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not load account access.");
      if (
        request !== version.current ||
        currentSession.current?.user.id !== value.user.id
      )
        return;
      const result = data as AccountProfile;
      let preferred = "";
      try {
        preferred =
          localStorage.getItem("octolab.workspace." + result.user.id) || "";
      } catch {}
      const selected =
        result.workspaces.find((w) => w.id === preferred) ??
        result.workspaces[0];
      if (routedAccount.current !== result.user.id) {
        routedAccount.current = result.user.id;
        if (location.hash === "#dashboard" || location.hash === "#signin") {
          if (result.isAdmin) location.hash = "admin";
          else if (!result.workspaces.length && result.companies?.length)
            location.hash = "company";
        }
      }
      setProfile(result);
      activeWorkspace.current = selected?.id || "";
      setWorkspaceId(selected?.id || "");
      setAccountSession(value.access_token, selected?.id || "", result.user.id);
      setError("");
    } catch (e) {
      if (request === version.current) {
        setProfile(undefined);
        setWorkspaceId("");
        setAccountSession(value.access_token, "", value.user.id);
        setError((e as Error).message);
      }
    } finally {
      if (request === version.current) setReady(true);
    }
  };
  useEffect(() => {
    const changed = () => setRoute(location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    let disposed = false,
      unsubscribe = () => {};
    void (async () => {
      try {
        const response = await fetch("/api/auth/config");
        if (!response.ok) throw new Error("Could not load sign-in settings.");
        const settings = (await response.json()) as AuthPublicConfig;
        if (disposed) return;
        if (typeof settings.enabled !== "boolean")
          throw new Error("Sign-in settings are unavailable.");
        if (settings.enabled) {
          const origin = new URL(settings.url);
          if (
            origin.protocol !== "https:" ||
            !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname) ||
            origin.pathname !== "/" ||
            origin.username ||
            origin.password
          )
            throw new Error("Sign-in is not configured correctly.");
        }
        setConfig(settings);
        if (!settings.enabled) {
          setReady(true);
          return;
        }
        if (!/^sb_publishable_/.test(settings.publishableKey))
          throw new Error("Sign-in is not configured correctly.");
        const { createClient } = await import("@supabase/supabase-js");
        if (disposed) return;
        const supabase = createClient(settings.url, settings.publishableKey, {
          auth: {
            flowType: "pkce",
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        client.current = supabase;
        const apply = (value: Session | null) => {
          if (disposed) return;
          const changed = currentSession.current?.user.id !== value?.user.id;
          if (changed) {
            version.current++;
            setProfile(undefined);
            setWorkspaceId("");
          }
          currentSession.current = value;
          setSession(value);
          if (changed || !value) activeWorkspace.current = "";
          setAccountSession(
            value?.access_token || "",
            activeWorkspace.current,
            value?.user.id || "",
          );
          if (!value) setReady(true);
        };
        const { data } = supabase.auth.onAuthStateChange((event, value) => {
          if (event === "PASSWORD_RECOVERY") setMode("recover");
          apply(value);
        });
        unsubscribe = () => {
          data.subscription.unsubscribe();
          supabase.auth.stopAutoRefresh();
        };
        const initial = await supabase.auth.getSession();
        if (initial.error) throw initial.error;
        apply(initial.data.session);
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setReady(true);
        }
      }
    })();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (session) void loadProfile(session);
  }, [session?.access_token]);
  useEffect(() => {
    const invalid = () => {
      if (config?.enabled && currentSession.current) {
        clear();
        setError("Your session ended. Sign in again.");
        void client.current?.auth.signOut({ scope: "local" }).catch(() => {});
      }
    };
    window.addEventListener("octolab-session-invalid", invalid);
    return () => window.removeEventListener("octolab-session-invalid", invalid);
  }, [config]);
  useEffect(() => {
    if (!config?.enabled) return;
    const refresh = () => {
      if (currentSession.current) void loadProfile(currentSession.current);
    };
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [config?.enabled]);
  const publicPage =
    !location.pathname.startsWith("/research") && (!route || route === "#home");
  const context: AccountContext = {
    enabled: !!config?.enabled,
    profile,
    workspaceId,
    select,
    signOut,
    refresh: async () => {
      if (currentSession.current) await loadProfile(currentSession.current);
    },
    create: () => {
      creationKey.current = crypto.randomUUID();
      setCreating(true);
      setError("");
    },
  };
  if (config && !config.enabled) return <>{children}</>;
  if (publicPage)
    return <Context.Provider value={context}>{children}</Context.Provider>;
  const independentArea =
    route.startsWith("#company") ||
    route.startsWith("#admin") ||
    (profile?.isAdmin && !workspaceId);
  if (
    profile &&
    (workspaceId || independentArea) &&
    !creating &&
    mode !== "recover"
  )
    return (
      <Context.Provider value={context}>
        <div
          key={profile.user.id + ":" + workspaceId}
          className="account-workspace"
        >
          {children}
        </div>
      </Context.Provider>
    );
  const workspaceForm = !!session && !!profile && (!workspaceId || creating);
  const title = workspaceForm
    ? "Create your workspace"
    : mode === "signup"
      ? "Create your account"
      : mode === "reset"
        ? "Reset your password"
        : mode === "recover"
          ? "Choose a new password"
          : "Sign in to octolab";
  return (
    <main className="account-page">
      <a href="#home" className="account-brand">
        <img src="/octolab.svg" width="34" height="34" alt="" />
        octolab
      </a>
      <section className="account-card">
        <h1>{!ready ? "Loading your workspace…" : title}</h1>
        <p>
          {workspaceForm
            ? "Use tools through your agent. Your workspace holds activity, routing settings, credits, and API keys."
            : route.startsWith("#company")
              ? "Sign in to register or manage your tool company."
              : "Sign in to manage your tools and usage."}
        </p>
        {error && <InlineError message={error} />}
        {notice && (
          <p role="status" className="account-notice">
            {notice}
          </p>
        )}
        {workspaceForm && !workspaceId && (
          <div className="account-purpose">
            <p>Here to provide a tool?</p>
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false);
                location.hash = "company";
              }}
            >
              Register a tool company
            </Button>
            <p>
              Company registration has its own review and does not need a user
              workspace.
            </p>
          </div>
        )}
        {ready &&
          config?.enabled &&
          (workspaceForm || !session || mode === "recover") && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy || !client.current) return;
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const actionUser = currentSession.current?.user.id;
                  if (workspaceForm) {
                    const response = await fetch("/api/auth/workspaces", {
                        method: "POST",
                        headers: {
                          Authorization:
                            "Bearer " + currentSession.current!.access_token,
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                          name,
                          requestKey: creationKey.current,
                        }),
                      }),
                      data = await response.json();
                    if (!response.ok)
                      throw new Error(
                        data.error || "Could not create workspace.",
                      );
                    if (currentSession.current?.user.id !== actionUser) return;
                    try {
                      localStorage.setItem(
                        "octolab.workspace." + profile!.user.id,
                        data.id,
                      );
                    } catch {}
                    await loadProfile(currentSession.current!);
                    setCreating(false);
                    setName("");
                  } else {
                    const auth = client.current.auth,
                      redirect =
                        location.origin +
                        "/?auth_callback=1" +
                        (route.startsWith("#company")
                          ? "#company"
                          : route.startsWith("#admin")
                            ? "#admin"
                            : "#dashboard");
                    if (mode === "signin") {
                      const { error } = await auth.signInWithPassword({
                        email,
                        password,
                      });
                      if (error) throw error;
                      setPassword("");
                    } else if (mode === "signup") {
                      const { error, data } = await auth.signUp({
                        email,
                        password,
                        options: { emailRedirectTo: redirect },
                      });
                      if (error) throw error;
                      setPassword("");
                      if (!data.session)
                        setNotice(
                          "Check your email to confirm your account, then sign in.",
                        );
                    } else if (mode === "reset") {
                      const { error } = await auth.resetPasswordForEmail(
                        email,
                        { redirectTo: redirect },
                      );
                      if (error) throw error;
                      setNotice(
                        "If the account exists, a reset link will arrive by email.",
                      );
                    } else {
                      const { error } = await auth.updateUser({ password });
                      if (error) throw error;
                      setPassword("");
                      setMode("signin");
                      setNotice("Password updated.");
                    }
                  }
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {workspaceForm ? (
                <label>
                  Workspace name
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={80}
                    autoComplete="organization"
                    placeholder="My workspace"
                  />
                </label>
              ) : (
                <>
                  {mode !== "recover" && (
                    <label>
                      Email
                      <Input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                      />
                    </label>
                  )}
                  {mode !== "reset" && (
                    <label>
                      Password
                      <Input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={mode === "signin" ? 1 : 12}
                        maxLength={256}
                        autoComplete={
                          mode === "signin"
                            ? "current-password"
                            : "new-password"
                        }
                      />
                    </label>
                  )}
                </>
              )}
              <Button type="submit" disabled={busy || !client.current}>
                {busy
                  ? "Working…"
                  : workspaceForm
                    ? "Create workspace"
                    : mode === "signup"
                      ? "Create account"
                      : mode === "reset"
                        ? "Send reset link"
                        : mode === "recover"
                          ? "Update password"
                          : "Sign in"}
                <ArrowRight size={16} />
              </Button>
            </form>
          )}
        {ready && session && !profile && mode !== "recover" && (
          <div className="account-actions">
            <Button onClick={() => void loadProfile(session)}>
              Retry workspace access
            </Button>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        )}
        {ready && (!config || (config.enabled && !client.current)) && (
          <Button onClick={() => location.reload()}>Retry</Button>
        )}
        {workspaceForm && (
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
        )}
        {workspaceForm && creating && workspaceId && (
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Back to workspace
          </Button>
        )}
        {ready && config?.enabled && !session && (
          <div className="account-links">
            <Button
              variant="link"
              onClick={() => {
                setMode(mode === "signup" ? "signin" : "signup");
                setError("");
                setNotice("");
                setPassword("");
              }}
            >
              {mode === "signup"
                ? "Already have an account? Sign in"
                : "Create an account"}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setMode(mode === "reset" ? "signin" : "reset");
                setError("");
                setNotice("");
                setPassword("");
              }}
            >
              {mode === "reset" ? "Back to sign in" : "Forgot password?"}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
