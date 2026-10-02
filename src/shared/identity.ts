// The workspace owner identity.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT THE GITHUB LOGIN
// ────────────────────────────────────────────────────────────────────────────
//
// GitHub usernames are MUTABLE and the old one becomes claimable:
//
//   "After changing your username, your old username becomes available for anyone
//    else to claim."  -- docs.github.com/account-and-profile/concepts/username-changes
//
// Keying workspaces on the login would therefore mean that renaming your account loses
// you your workspaces, and -- much worse -- that whoever claims the freed name inherits
// them. The numeric user id is immutable, so it is the only safe key.
//
// This is a CONTRACT VALUE: pestilence stores and compares the same string. Changing
// the format re-owns nothing -- existing workspaces keep the old value and will not
// match -- which is deliberate, because silently re-owning workspaces would be worse.

const OWNER_PREFIX = "github";

/** The owner identifier for a GitHub user, from the numeric id. */
export function ownerIdOf(githubUserId: number): string {
  return `${OWNER_PREFIX}#${githubUserId}`;
}
