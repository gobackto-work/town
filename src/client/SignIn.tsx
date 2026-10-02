import type { AuthFailureCode } from "../shared/types.ts";
import { takeQueryCode } from "./queryMessage.ts";

/**
 * What each failure code means, said plainly.
 *
 * The server sends codes rather than messages because they travel in a redirect URL, and
 * the translation belongs on the side that can also offer a next step.
 */
const EXPLANATIONS: Record<AuthFailureCode, string> = {
  state_mismatch: "That sign-in attempt expired or did not match this browser. Try again.",
  not_a_member: "Your GitHub account is not a member of the organisation that may use this platform.",
  pending_invitation: "Your invitation to the organisation has not been accepted yet. Accept it, then try again.",
  github_unavailable: "GitHub could not be reached. Try again in a moment.",
};

interface SignInProps {
  readonly error: string | null;
}

export function SignIn({ error }: SignInProps) {
  // Read once and stripped from the URL, for the same reason as the edge message: a
  // sticky failure banner outlives the failure and is then believed.
  const code = takeQueryCode("auth_error");
  const explanation = code === null ? null : (EXPLANATIONS[code as AuthFailureCode] ?? "Sign-in failed. Try again.");

  return (
    <section className="signin">
      <header>
        <h1>town</h1>
        <p className="sub">Pi agent workspaces</p>
      </header>

      {/* Two different failures, shown differently on purpose: a rejected sign-in is
          something the person can act on, whereas the API being unreachable is not. */}
      {explanation !== null && (
        <p className="banner" role="alert">
          {explanation}
        </p>
      )}
      {error !== null && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      <a className="button" href="/auth/login">
        Sign in with GitHub
      </a>
      <p className="muted small">Access is limited to members of the organisation.</p>
    </section>
  );
}
