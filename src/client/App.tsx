import { SignIn } from "./SignIn.tsx";
import { Workspaces } from "./Workspaces.tsx";
import { useSession } from "./useSession.ts";

export function App() {
  const session = useSession();

  // Rendered rather than shown as an error, so a slow first request does not flash a
  // sign-in link at someone who is already signed in.
  if (session.loading) {
    return (
      <main>
        <p className="empty">Loading&hellip;</p>
      </main>
    );
  }

  return <main>{session.user === null ? <SignIn error={session.error} /> : <Workspaces user={session.user} />}</main>;
}
