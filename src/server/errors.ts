// Errors raised by things town talks to, as opposed to errors town raises about the
// caller. They map to 502: from town's perspective an upstream that fails or is absent
// is an upstream fault, and the caller can do nothing with the difference.

/**
 * The upstream could not be reached at all.
 *
 * Deliberately NOT an ApiError. "That workspace does not exist" and "I could not ask"
 * are the same status to a careless caller and entirely different facts to a user --
 * collapsing them is how a UI reports a deleted workspace when the control plane is
 * merely down.
 */
export class UpstreamUnreachable extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} is unreachable`, { cause });
    this.name = "UpstreamUnreachable";
  }
}

/** The upstream answered, and the answer was an error. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly what: string;

  constructor(what: string, status: number, message: string) {
    super(`${what} returned ${status}: ${message}`);
    this.name = "UpstreamError";
    this.status = status;
    this.what = what;
  }
}
