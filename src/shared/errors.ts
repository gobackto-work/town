/**
 * An error that carries a stable machine-readable code alongside a human message.
 *
 * Shared by the BFF and the browser, because both need to branch on the code and
 * neither benefits from its own near-identical copy -- two classes like this is how
 * the two sides end up disagreeing about what a code means.
 *
 * Callers branch on `code`, never on `message`: the message is for a person and is
 * expected to change.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
