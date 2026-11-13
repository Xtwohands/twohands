import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight } from "@untitledui/icons";
import type { AccountProfile, AuthPublicConfig } from "../server/account-types";
import type { CompanyPreviewTarget } from "../server/company-types";
import { setAccountSession, setPreviewRole } from "./api";
import { Button } from "./components/ui/button";
import { AccountMenu } from "./AccountMenu";
import { Input } from "./components/ui/input";
import { InlineError } from "./observation-ui";
import "./account.css";
type AccountContext = {
  sessionEpoch?: number;
  enabled: boolean;
  profile?: AccountProfile;
  workspaceId: string;
  select: (id: string) => void;
  signOut: () => void;
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
  if (!account.enabled)
    return showIdentity ? (
      <AccountMenu label="Local account" detail="Local mode" />
    ) : null;
  if (!account.profile) return null;
  const selector =
    showWorkspace &&
    account.profile.isAdmin &&
    account.profile.workspaces.length > 0 ? (
      <label className="account-scope-select">
        <span>Customer account</span>
        <select
          aria-label="Customer account"
          value={account.workspaceId}
          onChange={(e) => account.select(e.target.value)}
        >
          {account.profile.workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  if (!showIdentity) return selector;
  return (
    <AccountMenu
      label={account.profile.user.email}
      detail={account.profile.isAdmin ? "Administrator" : "Personal account"}
      onSignOut={account.signOut}
    >
      {selector}
    </AccountMenu>
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
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [route, setRoute] = useState(location.hash);
  const client = useRef<SupabaseClient | null>(null),
    currentSession = useRef<Session | null>(null),
    sessionEpoch = useRef(0),
    version = useRef(0);
  const memoryAuthStorage = useRef(new Map<string, string>());
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
      if (
        request !== version.current ||
        currentSession.current?.user.id !== value.user.id
      )
        return;
      if (response.status === 401) {
        signOut();
        setError(data.error || "Your session ended. Sign in again.");
        return;
      }
      if (!response.ok)
        throw new Error(data.error || "Could not load account access.");
      const result = data as AccountProfile;
      const customerArea =
        location.hash &&
        !/^#(?:home|signin|company|admin|settings)/.test(location.hash) &&
        !location.pathname.startsWith("/research");
      if (
        customerArea &&
        !result.isAdmin &&
        !result.canPreview &&
        !result.workspaces.length &&
        !(location.hash === "#dashboard" && result.companies?.length)
      ) {
        const setup = await fetch("/api/auth/setup", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + value.access_token,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        const account = await setup.json();
        if (
          request !== version.current ||
          currentSession.current?.user.id !== value.user.id
        )
          return;
        if (setup.status === 401) {
          signOut();
          setError(account.error || "Your session ended. Sign in again.");
          return;
        }
        if (!setup.ok)
          throw new Error(account.error || "Could not set up your account.");
        result.workspaces = [account];
      }
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
          else if (location.hash === "#signin") location.hash = "dashboard";
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
            storage: {
              getItem: (key) => {
                try {
                  return localStorage.getItem(key);
                } catch {
                  return memoryAuthStorage.current.get(key) ?? null;
                }
              },
              setItem: (key, value) => {
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
    if (
      session &&
      profile &&
      !profile.workspaces.length &&
      !profile.isAdmin &&
      !profile.canPreview
    )
      void loadProfile(session);
  }, [route]);
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
    sessionEpoch: sessionEpoch.current,
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
  if (profile && (workspaceId || independentArea) && mode !== "recover")
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
          {previewRole === "company" && (
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
  const emptyPreview = !!profile && previewRole === "user" && !workspaceId;
  const title = emptyPreview
    ? "No customer account available to preview"
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
        {previewRole === "user" && (
          <Button variant="outline" onClick={() => void context.preview(null)}>
            Return to admin
          </Button>
        )}
        {previewRole === "company" && (
          <PreviewNotice
            role={previewRole}
            target={previewTarget}
            targets={previewTargets}
            onTarget={(target) => void context.preview("company", target)}
            onExit={() => void context.preview(null)}
          />
        )}
        <h1>
          {!ready || (session && !profile && !error)
            ? "Loading your account…"
            : title}
        </h1>
        <p>
          {emptyPreview
            ? "This preview has no customer account activity yet."
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
        {ready && config?.enabled && (!session || mode === "recover") && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !client.current) return;
              setBusy(true);
              setError("");
              setNotice("");
              try {
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
                  const { error } = await auth.resetPasswordForEmail(email, {
                    redirectTo: redirect,
                  });
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
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
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
                      mode === "signin" ? "current-password" : "new-password"
                    }
                  />
                </label>
              )}
            </>
            <Button type="submit" disabled={busy || !client.current}>
              {busy
                ? "Working…"
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
              Retry account access
            </Button>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        )}
        {ready && (!config || (config.enabled && !client.current)) && (
          <Button onClick={() => location.reload()}>Retry</Button>
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
