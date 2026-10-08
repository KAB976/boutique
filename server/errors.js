export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const bad = (message, code = 'invalid') => new HttpError(400, code, message);
export const forbidden = (message = "Vous n'avez pas le droit de faire cela.") => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Introuvable.') => new HttpError(404, 'not_found', message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);
