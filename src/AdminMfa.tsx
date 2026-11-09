import { useEffect, useState } from "react";
import { useAccount } from "./AccountGate";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { InlineError, Panel } from "./observation-ui";
import { useActorGeneration } from "./useActorGeneration";

/** Enrollment secrets exist only in this component and are cleared on account/route change. */
export function AdminMfa() {
  const account = useAccount();
  const [factor, setFactor] = useState("");
  const [setup, setSetup] = useState<{ qr: string; secret: string }>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const actor = `${account.profile?.user.id}:${account.sessionEpoch}:${account.previewRole}`;
  const operation = useActorGeneration(actor);
  useEffect(() => {
    setFactor("");
    setSetup(undefined);
    setCode("");
    setError("");
    setBusy(false);
  }, [actor]);
  if (!account.profile?.isAdmin || account.previewRole) return null;
  const client = account.authClient;
  async function begin() {
    if (!client) return;
    const generation = operation.next();
    setBusy(true);
    setError("");
    setSetup(undefined);
    setCode("");
    try {
      const listed = await client.auth.mfa.listFactors();
      if (!operation.current(generation)) return;
      if (listed.error) throw listed.error;
      const verified = listed.data.totp.find((f) => f.status === "verified");
      if (verified) setFactor(verified.id);
      else {
        // A previous abandoned setup cannot reveal its secret again; restart only unverified TOTP setup.
        for (const f of listed.data.all.filter(
          (f) => f.factor_type === "totp" && f.status === "unverified",
        )) {
          const removed = await client.auth.mfa.unenroll({ factorId: f.id });
          if (!operation.current(generation)) return;
          if (removed.error) throw removed.error;
        }
        const enrolled = await client.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: "octolab administration",
        });
        if (!operation.current(generation)) return;
        if (enrolled.error) throw enrolled.error;
        setFactor(enrolled.data.id);
        setSetup({
          qr: enrolled.data.totp.qr_code,
          secret: enrolled.data.totp.secret,
        });
      }
    } catch {
      if (operation.current(generation))
        setError(
          "Could not prepare your authenticator. Try again or contact your workspace owner.",
        );
    } finally {
      if (operation.current(generation)) setBusy(false);
    }
  }
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!account.verifyAdminMfa) return;
    const generation = operation.next();
    setBusy(true);
    setError("");
    try {
      await account.verifyAdminMfa(factor, code);
      if (!operation.current(generation)) return;
      setCode("");
      setSetup(undefined);
      setFactor("");
      await account.refresh();
    } catch {
      if (operation.current(generation))
        setError(
          "The verification code was not accepted. Enter a current code and try again.",
        );
    } finally {
      if (operation.current(generation)) {
        setCode("");
        setBusy(false);
      }
    }
  }
  return (
    <Panel
      title="Administrator security"
      description="Use your own account and an authenticator before opening privileged controls."
    >
      <p>
        {account.profile.adminMfaVerified
          ? "Two-factor verification is active for this session."
          : "Two-factor verification is required for administrator actions."}
      </p>
      <InlineError message={error} />
      {!factor && !account.profile.adminMfaVerified && (
        <Button onClick={begin} disabled={busy || !client}>
          {busy ? "Preparing…" : "Set up or verify authenticator"}
        </Button>
      )}
      {factor && (
        <form onSubmit={verify} className="admin-mfa-form">
          {setup && (
            <>
              <p>
                Scan this code in your authenticator, or enter the setup key
                manually. Keep the setup key private.
              </p>
              <img
                src={setup.qr}
                width={180}
                height={180}
                alt="Authenticator enrollment QR code"
              />
              <p>
                <code>{setup.secret}</code>
              </p>
            </>
          )}
          <label>
            Authenticator code
            <Input
              disabled={busy}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
            />
          </label>
          <Button disabled={busy || code.length !== 6}>
            {busy ? "Verifying…" : "Verify authenticator"}
          </Button>
        </form>
      )}
      <p>
        If you lose your authenticator, another trusted administrator can
        coordinate account recovery through the Auth provider. There is no MFA
        bypass in octolab.
      </p>
    </Panel>
  );
}
