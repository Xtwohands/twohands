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
import type { CompanyPreviewTarget } from "../server/company-types";
import { setAccountSession, setPreviewRole } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { InlineError } from "./observation-ui";
import "./account.css";
type AccountContext = {
  authClient?: SupabaseClient | null;
  sessionEpoch?: number;
  verifyAdminMfa?: (factorId: string, code: string) => Promise<void>;
  enabled: boolean;
  profile?: AccountProfile;
  workspaceId: string;
  select: (id: string) => void;
  signOut: () => void;
  create: () => void;
  refresh: () => Promise<void>;
  previewRole: "user" | "company" | null;
  previewTarget: string | null;
  previewTargets: CompanyPreviewTarget[];
  previewTargetError: string;
  reloadPreviewTargets: () => Promise<void>;
  preview: (role: "user" | "company" | null, target?: string) => Promise<void>;
};
const Context = createContext<AccountContext>({
  enabled: false,
  workspaceId: "",
  select: () => {},
  signOut: () => {},
  create: () => {},
  refresh: async () => {},
  previewRole: null,
  previewTarget: null,
  previewTargets: [],
  previewTargetError: "",
  reloadPreviewTargets: async () => {},
  preview: async () => {},
});
export const useAccount = () => useContext(Context);
export function AccountControls({
  showWorkspace = true,
  showIdentity = true,
}: {
  showWorkspace?: boolean;
  showIdentity?: boolean;
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
      {showIdentity && (
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
      )}
    </div>
  );
}
function PreviewNotice({
  role,
  target,
  targets,
  onTarget,
  onExit,
}: {
  role: "user" | "company";
  target: string | null;
  targets: CompanyPreviewTarget[];
  onTarget: (target: string) => void;
  onExit: () => void;
}) {
  return (
    <div className="preview-notice" role="status">
      <span>Previewing {role === "user" ? "as user" : "company"}</span>
      {role === "company" && targets.length > 0 && (
        <select
          aria-label="Preview company"
          value={target || ""}
          onChange={(e) => onTarget(e.target.value)}
        >
          {targets.map((item) => (
            <option key={item.target} value={item.target}>
              {item.name}
              {item.kind === "provider" ? " · integrated provider" : ""}
            </option>
          ))}
        </select>
      )}
      <Button variant="outline" size="sm" onClick={onExit}>
        Return to admin
      </Button>
    </div>
  );
}
export function AccountGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthPublicConfig>();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AccountProfile>();
  const [switching, setSwitching] = useState(false);
  const [previewRole, setPreview] = useState<"user" | "company" | null>(null);
  const previewRef = useRef<"user" | "company" | null>(null);
  const targetRef = useRef<string | null>(null);
  const previewGeneration = useRef(0);
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const [previewTargets, setPreviewTargets] = useState<CompanyPreviewTarget[]>(
    [],
  );
  const [previewTargetError, setPreviewTargetError] = useState("");
  const canPreviewRef = useRef(false);
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
    sessionEpoch = useRef(0),
    version = useRef(0),
    creationKey = useRef(crypto.randomUUID());
  const mfaAdoptions = useRef(
    new Map<string, { epoch: number; userId: string }>(),
  );
  const memoryAuthStorage = useRef(new Map<string, string>());
  const staleMfa = (token?: string) => {
    const attempt = token && mfaAdoptions.current.get(token);
    return (
      !!attempt &&
      (attempt.epoch !== sessionEpoch.current ||
        attempt.userId !== currentSession.current?.user.id)
    );
  };
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
    sessionEpoch.current++;
    canPreviewRef.current = false;
    previewRef.current = null;
    targetRef.current = null;
    previewGeneration.current++;
    setPreviewTarget(null);
    setPreviewTargets([]);
    setPreviewTargetError("");
    setPreviewRole(null);
    setPreview(null);
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
          headers: {
            Authorization: "Bearer " + value.access_token,
            ...(previewRef.current
              ? { "X-Octolab-Preview": previewRef.current }
              : {}),
            ...(targetRef.current
              ? { "X-Octolab-Preview-Target": targetRef.current }
              : {}),
          },
        }),
        data = await response.json();
      if (response.status === 401) {
        signOut();
        setError(data.error || "Your session ended. Sign in again.");
        return;
      }
      if (!response.ok)
        throw new Error(data.error || "Could not load account access.");
      if (
        request !== version.current ||
        currentSession.current?.user.id !== value.user.id
      )
        return;
      const result = data as AccountProfile;
      canPreviewRef.current = !!(result.canPreview || result.isAdmin);
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
      return result;
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
  const reloadPreviewTargets = async () => {
    const current = currentSession.current;
    if (!current || !canPreviewRef.current) return;
    try {
      const response = await fetch("/api/auth/preview-targets", {
        headers: { Authorization: "Bearer " + current.access_token },
      });
      const data = await response.json();
      if (
        currentSession.current?.user.id !== current.user.id ||
        !canPreviewRef.current
      )
        return;
      if (!response.ok)
        throw new Error(data.error || "Could not load company previews.");
      setPreviewTargets(data);
      setPreviewTargetError("");
    } catch (e) {
      if (currentSession.current?.user.id === current.user.id)
        setPreviewTargetError((e as Error).message);
    }
  };
  useEffect(() => {
    if (profile?.canPreview || profile?.isAdmin) void reloadPreviewTargets();
  }, [profile?.canPreview, profile?.isAdmin]);
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
            // Fence only staged MFA adoption. The SDK otherwise persists a late
            // setSession result even if the operator signed out during getUser.
            storage: {
              getItem: (key) => {
                try {
                  return localStorage.getItem(key);
                } catch {
                  return memoryAuthStorage.current.get(key) ?? null;
                }
              },
              setItem: (key, value) => {
                let token: string | undefined;
                try {
                  token = JSON.parse(value)?.access_token;
                } catch {}
                // Throw before SDK save/notification/broadcast, rather than
                // silently skipping storage then allowing a stale SIGNED_IN.
                if (staleMfa(token))
                  throw new Error("Administrator verification was superseded.");
                memoryAuthStorage.current.set(key, value);
                try {
                  localStorage.setItem(key, value);
                } catch {}
              },
              removeItem: (key) => {
                memoryAuthStorage.current.delete(key);
                try {
                  localStorage.removeItem(key);
                } catch {}
              },
            },
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        client.current = supabase;
        const apply = (value: Session | null) => {
          if (disposed) return;
          if (currentSession.current?.access_token !== value?.access_token)
            sessionEpoch.current++;
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
          if (staleMfa(value?.access_token)) return;
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
    authClient: client.current,
    sessionEpoch: sessionEpoch.current,
    verifyAdminMfa: async (factorId, code) => {
      const source = currentSession.current;
      const epoch = sessionEpoch.current;
      const main = client.current;
      if (!source || !main || !config?.enabled)
        throw new Error("Sign in again.");
      const current = () =>
        epoch === sessionEpoch.current &&
        currentSession.current?.user.id === source.user.id;
      const { createClient } = await import("@supabase/supabase-js");
      if (!current()) return;
      // Challenge/verify must not persist into the main browser session. Adopt
      // only a still-current result, fencing both storage and auth callbacks.
      const isolated = createClient(config.url, config.publishableKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: `octolab-mfa-${crypto.randomUUID()}`,
        },
      });
      try {
        const seeded = await isolated.auth.setSession({
          access_token: source.access_token,
          refresh_token: source.refresh_token,
        });
        if (!current()) return;
        if (seeded.error) throw seeded.error;
        const verified = await isolated.auth.mfa.challengeAndVerify({
          factorId,
          code,
        });
        if (!current()) return;
        if (verified.error) throw verified.error;
        const token = verified.data.access_token;
        const claims = JSON.parse(
          atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        ) as { sub?: string; exp?: number };
        if (
          claims.sub !== source.user.id ||
          !claims.exp ||
          claims.exp * 1000 < Date.now() + 60000
        )
          throw new Error(
            "Repeat administrator verification with a current session.",
          );
        mfaAdoptions.current.set(token, { epoch, userId: source.user.id });
        try {
          const adopted = await main.auth.setSession({
            access_token: token,
            refresh_token: verified.data.refresh_token,
          });
          if (adopted.error && current()) throw adopted.error;
        } finally {
          mfaAdoptions.current.delete(token);
        }
      } finally {
        isolated.auth.stopAutoRefresh();
      }
    },
    enabled: !!config?.enabled,
    profile,
    workspaceId,
    previewRole,
    previewTarget,
    previewTargets,
    previewTargetError,
    reloadPreviewTargets,
    preview: async (role, target) => {
      if (!currentSession.current || !canPreviewRef.current) return;
      if (role === "company" && !target) {
        setPreviewTargetError("Choose a company to preview.");
        return;
      }
      const operation = ++previewGeneration.current;
      previewRef.current = role;
      targetRef.current = role === "company" ? target! : null;
      setPreviewTarget(targetRef.current);
      setPreviewRole(role, targetRef.current);
      setPreview(role);
      setSwitching(true);
      setProfile(undefined);
      let loaded: AccountProfile | undefined;
      try {
        loaded = await loadProfile(currentSession.current);
      } finally {
        if (operation === previewGeneration.current) setSwitching(false);
      }
      if (operation !== previewGeneration.current || !loaded) return;
      location.hash =
        role === "company"
          ? `company/${loaded.companyPreview?.id || ""}/insights`
          : role === "user"
            ? "dashboard"
            : "admin";
    },
    select,
    signOut,
    refresh: async () => {
      const started = version.current;
      const userId = currentSession.current?.user.id;
      const fresh = await client.current?.auth.getSession();
      if (
        started !== version.current ||
        currentSession.current?.user.id !== userId
      )
        return;
      const value = fresh?.data.session ?? currentSession.current;
      if (value) {
        currentSession.current = value;
        await loadProfile(value);
      }
    },
    create: () => {
      creationKey.current = crypto.randomUUID();
      setCreating(true);
      setError("");
    },
  };
  if (switching)
    return (
      <main className="account-page">
        <section className="account-card">
          <h1>Switching experience…</h1>
          <p>Applying your access permissions.</p>
        </section>
      </main>
    );
  if (config && !config.enabled) return <>{children}</>;
  if (publicPage)
    return <Context.Provider value={context}>{children}</Context.Provider>;
  const independentArea =
    route.startsWith("#company") ||
    route.startsWith("#admin") ||
    route.startsWith("#settings") ||
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
          key={
            profile.user.id +
            ":" +
            workspaceId +
            ":" +
            previewRole +
            ":" +
            previewTarget
          }
          className="account-workspace"
        >
          {children}
          {previewRole && (
            <PreviewNotice
              role={previewRole}
              target={previewTarget}
              targets={previewTargets}
              onTarget={(target) => void context.preview("company", target)}
              onExit={() => void context.preview(null)}
            />
          )}
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
        {previewRole && (
          <PreviewNotice
            role={previewRole}
            target={previewTarget}
            targets={previewTargets}
            onTarget={(target) => void context.preview("company", target)}
            onExit={() => void context.preview(null)}
          />
        )}
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
